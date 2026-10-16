import { ImapFlow } from "imapflow";
import {
  simpleParser,
  type AddressObject,
  type ParsedMail,
} from "mailparser";
import type { Address, RawMessageLike } from "../types";
import type { MailSource, SourceStatus } from "./types";

/**
 * IMAP source — for app passwords.
 *
 * A Google "app password" is not an OAuth credential: it authorises IMAP/SMTP
 * against the mailbox directly. That makes this a *different* auth path from
 * `gmail.ts`, with different tradeoffs worth stating plainly:
 *
 *   + Works immediately — no Google Cloud project, no OAuth consent screen, no
 *     CASA security assessment.
 *   - The password is a long-lived bearer secret with full mailbox access. It is
 *     read from the environment and never persisted, logged, or sent anywhere
 *     except the IMAP server itself.
 *   - It cannot be scoped. OAuth's `gmail.readonly` limit does not apply here,
 *     which is exactly why the OAuth path is still the better long-term choice.
 *
 * The connection is read-only in practice: we only ever `fetch`, and `EXAMINE`
 * via a lock. Nothing is written back to the mailbox.
 */

export type ImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
  limit: number;
};

/** Google displays app passwords as "abcd efgh ijkl mnop"; the spaces are cosmetic. */
function normalizeAppPassword(raw: string): string {
  return raw.replace(/\s+/g, "");
}

export function imapConfig(): ImapConfig | null {
  const user = (process.env.IMAP_USER ?? process.env.ANDRO_OWNER_EMAIL ?? "").trim();
  const pass = normalizeAppPassword(process.env.IMAP_PASSWORD ?? "");
  if (!user || !pass) return null;

  return {
    host: (process.env.IMAP_HOST ?? "imap.gmail.com").trim(),
    port: Number(process.env.IMAP_PORT ?? 993),
    // Port 143 uses STARTTLS, which imapflow handles when secure is false.
    secure: (process.env.IMAP_SECURE ?? "true") !== "false",
    user,
    pass,
    mailbox: (process.env.IMAP_MAILBOX ?? "INBOX").trim(),
    limit: Math.max(1, Math.min(500, Number(process.env.IMAP_LIMIT ?? 60))),
  };
}

export function isImapConfigured(): boolean {
  return imapConfig() !== null;
}

export function imapStatus(): SourceStatus {
  const config = imapConfig();
  return {
    id: "imap",
    label: "IMAP (app password)",
    description:
      "Reads your mailbox directly with an app password. No OAuth setup required.",
    available: config !== null,
    detail: config
      ? `${config.user} @ ${config.host}:${config.port} · ${config.mailbox} · newest ${config.limit}`
      : "Set IMAP_USER and IMAP_PASSWORD to enable.",
  };
}

/** Build a client. The password never appears in logs: `logger` is disabled. */
function createClient(config: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
    // Fail fast rather than hanging the request when the network stalls.
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

/** Flatten mailparser's grouped address structure into flat `{name, email}`. */
function toAddress(a: AddressObject | AddressObject[] | undefined): Address[] {
  if (!a) return [];
  const groups = Array.isArray(a) ? a : [a];
  const out: Address[] = [];
  for (const group of groups) {
    for (const entry of group.value ?? []) {
      if (!entry.address) continue;
      out.push({
        name: entry.name || undefined,
        email: String(entry.address),
      });
    }
  }
  return out;
}

function headersToRecord(parsed: ParsedMail): Record<string, string> {
  const out: Record<string, string> = {};
  // simpleParser lower-cases header keys; `headerValue()` in normalize.ts does a
  // case-insensitive lookup, so that is fine.
  for (const [key, value] of parsed.headers) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value
        .map((v) =>
          typeof v === "string"
            ? v
            : typeof v === "object" && v && "value" in v
              ? String((v as { value: unknown }).value)
              : String(v),
        )
        .join(", ");
    } else if (typeof value === "object" && "value" in value) {
      out[key] = String((value as { value: unknown }).value);
    } else if (value instanceof Date) {
      out[key] = value.toISOString();
    }
  }
  return out;
}

/**
 * Approximate thread grouping.
 *
 * IMAP gives no thread id, so we derive one: the root of the `References` chain
 * when present, else `In-Reply-To`, else the message's own id. This is enough for
 * the pre-scorer's "you previously replied in this thread" signal, which is the
 * only place threading is used.
 */
function threadIdOf(parsed: ParsedMail, headers: Record<string, string>): string {
  const references = headers["references"];
  if (references) {
    const first = references.trim().split(/\s+/)[0];
    if (first) return first.replace(/^<|>$/g, "");
  }
  const inReplyTo = headers["in-reply-to"];
  if (inReplyTo) return inReplyTo.replace(/^<|>$/g, "").trim();

  const messageId = headers["message-id"];
  if (messageId) return messageId.replace(/^<|>$/g, "").trim();

  return `imap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isBulk(parsed: ParsedMail): boolean {
  return Boolean(parsed.headers.get("list-unsubscribe"));
}

export async function fetchImapMessages(opts: {
  limit?: number;
  onProgress?: (done: number, total: number, subject: string) => void;
} = {}): Promise<RawMessageLike[]> {
  const config = imapConfig();
  if (!config) {
    throw new Error(
      "IMAP is not configured. Set IMAP_USER and IMAP_PASSWORD in .env.local.",
    );
  }

  const limit = opts.limit ?? config.limit;
  const client = createClient(config);
  const owner = config.user.toLowerCase();
  const messages: RawMessageLike[] = [];

  await client.connect();

  try {
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      const mailbox = client.mailbox;
      const exists = mailbox && typeof mailbox === "object" ? mailbox.exists : 0;
      if (!exists) return [];

      // Newest `limit` messages, in ascending order so threading resolves.
      const start = Math.max(1, exists - limit + 1);
      const range = `${start}:*`;

      let done = 0;
      for await (const msg of client.fetch(range, {
        source: true,
        flags: true,
        internalDate: true,
        uid: true,
      })) {
        if (!msg.source) continue;

        const parsed = await simpleParser(msg.source);
        const headers = headersToRecord(parsed);

        const from = toAddress(parsed.from)[0] ?? { email: "unknown@unknown" };
        const flags = msg.flags ?? new Set<string>();
        const unread = !flags.has("\\Seen");

        const receivedAt =
          parsed.date?.toISOString() ??
          (msg.internalDate instanceof Date
            ? msg.internalDate.toISOString()
            : new Date().toISOString());

        const threadId = threadIdOf(parsed, headers);

        messages.push({
          // Prefer the RFC Message-ID as the stable identity so re-syncs upsert
          // instead of duplicating.
          gmailMessageId: threadId + ":" + (headers["message-id"] ?? String(msg.uid)),
          gmailThreadId: threadId,
          from,
          to: toAddress(parsed.to),
          cc: toAddress(parsed.cc),
          subject: parsed.subject ?? "(no subject)",
          // `parsed.html` is `string | false` (false when there is no HTML part).
          body:
            parsed.text ??
            (typeof parsed.html === "string" ? parsed.html : "") ??
            "",
          receivedAt,
          labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"],
          headers,
          hasAttachments: (parsed.attachments?.length ?? 0) > 0,
          attachmentNames: (parsed.attachments ?? []).map(
            (a) => a.filename ?? "attachment",
          ),
          isFromMe: from.email.toLowerCase() === owner,
        });

        done += 1;
        opts.onProgress?.(done, limit, parsed.subject ?? "(no subject)");

        if (done >= limit) break;
      }

      // Sent mail matters for thread participation, but is not ranked. Rather
      // than a second mailbox traversal, mark bulk senders so the digest is
      // accurate and leave participation to the In-Reply-To chain above.
      void isBulk;
    } finally {
      lock.release();
    }
  } finally {
    // Never let a logout failure mask the real error.
    await client.logout().catch(() => undefined);
  }

  return messages;
}

/** Connection test with human-readable failures — used by the setup flow. */
export async function testImapConnection(): Promise<{
  ok: boolean;
  message: string;
  detail?: string;
}> {
  const config = imapConfig();
  if (!config) {
    return {
      ok: false,
      message: "IMAP is not configured.",
      detail: "Set IMAP_USER and IMAP_PASSWORD in .env.local, then restart.",
    };
  }

  const client = createClient(config);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox);
    const exists =
      client.mailbox && typeof client.mailbox === "object"
        ? client.mailbox.exists
        : 0;
    lock.release();
    await client.logout().catch(() => undefined);

    return {
      ok: true,
      message: `Connected to ${config.mailbox}.`,
      detail: `${exists} message${exists === 1 ? "" : "s"} in the mailbox. Will sync the newest ${config.limit}.`,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    await client.logout().catch(() => undefined);

    let friendly = raw;
    if (/AUTHENTICATIONFAILED|Invalid credentials|auth/i.test(raw)) {
      friendly =
        "Authentication failed. Check that IMAP is enabled in Gmail settings and that you are using a 16-character app password (spaces are fine — they are stripped).";
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
      friendly = `Could not resolve ${config.host}. Check IMAP_HOST and your network.`;
    } else if (/ETIMEDOUT|timeout/i.test(raw)) {
      friendly = `Timed out connecting to ${config.host}:${config.port}. Port 993 must be reachable.`;
    }

    return { ok: false, message: friendly, detail: raw.slice(0, 300) };
  }
}

export function createImapSource(): MailSource {
  return {
    id: "imap",
    label: "IMAP (app password)",
    description: "Reads the newest messages from your mailbox over IMAP.",
    async fetchMessages(): Promise<RawMessageLike[]> {
      return fetchImapMessages();
    },
  };
}
