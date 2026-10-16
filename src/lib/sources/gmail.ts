import type { Address, RawMessageLike } from "../types";
import type { MailSource, SourceStatus } from "./types";

/**
 * Gmail source (PLAN.md §3.1).
 *
 * Scope is deliberately minimal: `gmail.readonly` + `gmail.labels`. There is no
 * `gmail.send`, so the application can never send mail as the user — that
 * removes the highest-severity risk from the threat model entirely.
 *
 * Note (REVIEW.md #5): `gmail.readonly` is a Google *restricted* scope. Past a
 * small number of users it requires a CASA security assessment. That gates
 * distribution, not local development — in testing mode you add yourself as a
 * test user and it works immediately.
 *
 * Not configured in this environment, so the app defaults to the fixture source.
 * The implementation is real and complete; it just needs credentials.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.labels",
];

export type GmailTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

export function gmailConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI?.trim() ??
      "http://localhost:3000/api/gmail/callback",
  };
}

export function isGmailConfigured(): boolean {
  const c = gmailConfig();
  return Boolean(c.clientId && c.clientSecret);
}

export function gmailStatus(): SourceStatus {
  return {
    id: "gmail",
    label: "Gmail",
    description:
      "Live mailbox via OAuth. Read-only: the app can apply labels but can never send mail.",
    available: isGmailConfigured(),
    detail: isGmailConfigured()
      ? "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set."
      : "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI to enable.",
  };
}

export function buildAuthUrl(state: string): string {
  const c = gmailConfig();
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<GmailTokens> {
  const c = gmailConfig();
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Token exchange failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }
  const json = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<GmailTokens> {
  const c = gmailConfig();
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Token refresh failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  }
  const json = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

// ---------------------------------------------------------------------------
// Message fetching
// ---------------------------------------------------------------------------

type GmailHeader = { name: string; value: string };

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
};

type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
};

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function headersToRecord(headers: GmailHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    // Repeated headers are joined the way mail clients present them.
    out[h.name] = out[h.name] ? `${out[h.name]}, ${h.value}` : h.value;
  }
  return out;
}

/** Depth-first walk collecting the best text body and attachment names. */
function walkParts(part: GmailPart | undefined): {
  plain: string | null;
  html: string | null;
  attachments: string[];
} {
  let plain: string | null = null;
  let html: string | null = null;
  const attachments: string[] = [];

  const visit = (node: GmailPart | undefined): void => {
    if (!node) return;

    const isAttachment =
      Boolean(node.filename) ||
      (node.body?.attachmentId !== undefined && Boolean(node.filename));

    if (isAttachment && node.filename) {
      attachments.push(node.filename);
    } else if (node.mimeType === "text/plain" && node.body?.data) {
      plain = plain ?? decodeBase64Url(node.body.data);
    } else if (node.mimeType === "text/html" && node.body?.data) {
      html = html ?? decodeBase64Url(node.body.data);
    }

    for (const child of node.parts ?? []) visit(child);
  };

  visit(part);
  return { plain, html, attachments };
}

function parseAddress(raw: string): Address {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1].trim();
    return name ? { name, email: match[2].trim() } : { email: match[2].trim() };
  }
  return { email: raw.trim() };
}

function parseAddressList(raw: string | undefined): Address[] {
  if (!raw) return [];
  // Split on commas that are not inside quotes.
  const parts = raw.match(/(?:[^,"]|"[^"]*")+/g) ?? [];
  return parts.map((p) => parseAddress(p)).filter((a) => a.email.length > 0);
}

const OWNER_ADDRESSES = new Set<string>();

export function registerOwnerAddress(email: string): void {
  OWNER_ADDRESSES.add(email.toLowerCase());
}

function toRawMessage(message: GmailMessage): RawMessageLike {
  const headers = headersToRecord(message.payload?.headers);
  const { plain, html, attachments } = walkParts(message.payload);

  const from = parseAddress(headers["From"] ?? "");
  const receivedAt = message.internalDate
    ? new Date(Number(message.internalDate)).toISOString()
    : headers["Date"]
      ? new Date(headers["Date"]).toISOString()
      : new Date().toISOString();

  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    from,
    to: parseAddressList(headers["To"]),
    cc: parseAddressList(headers["Cc"]),
    subject: headers["Subject"] ?? "(no subject)",
    // Prefer plain text; fall back to HTML, which the normalizer will sanitize.
    body: plain ?? html ?? message.snippet ?? "",
    receivedAt,
    labelIds: message.labelIds ?? [],
    headers,
    hasAttachments: attachments.length > 0,
    attachmentNames: attachments,
    isFromMe: OWNER_ADDRESSES.has(from.email.toLowerCase()),
  };
}

async function gmailGet<T>(
  path: string,
  accessToken: string,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(
      `Gmail ${response.status} on ${path}: ${body.slice(0, 200)}`,
    );
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

/** Fetch message ids, incrementally when a historyId is supplied. */
export async function listMessageIds(
  accessToken: string,
  opts: { historyId?: string | null; maxResults?: number } = {},
): Promise<{ ids: string[]; historyId: string | null; fullResync: boolean }> {
  const maxResults = opts.maxResults ?? 200;

  if (opts.historyId) {
    try {
      const history = await gmailGet<{
        history?: { messages?: { id: string }[] }[];
        historyId?: string;
      }>(
        `/history?startHistoryId=${encodeURIComponent(opts.historyId)}&historyTypes=messageAdded`,
        accessToken,
      );
      const ids = (history.history ?? [])
        .flatMap((h) => h.messages ?? [])
        .map((m) => m.id);
      return {
        ids: Array.from(new Set(ids)),
        historyId: history.historyId ?? opts.historyId,
        fullResync: false,
      };
    } catch (error) {
      // historyId expires after roughly a week. A 404 means "resync fully"
      // rather than "fail" (REVIEW.md #6).
      if ((error as Error & { status?: number }).status === 404) {
        return { ids: [], historyId: null, fullResync: true };
      }
      throw error;
    }
  }

  const listing = await gmailGet<{
    messages?: { id: string }[];
    nextPageToken?: string;
  }>(`/messages?maxResults=${maxResults}&labelIds=INBOX`, accessToken);

  return {
    ids: (listing.messages ?? []).map((m) => m.id),
    historyId: null,
    fullResync: false,
  };
}

export async function fetchMessage(
  accessToken: string,
  id: string,
): Promise<RawMessageLike> {
  const message = await gmailGet<GmailMessage>(
    `/messages/${id}?format=full`,
    accessToken,
  );
  return toRawMessage(message);
}

export type GmailFetchOptions = {
  accessToken: string;
  historyId?: string | null;
  maxResults?: number;
};

export async function fetchGmailMessages(
  opts: GmailFetchOptions,
): Promise<{ messages: RawMessageLike[]; historyId: string | null; fullResync: boolean }> {
  const listing = await listMessageIds(opts.accessToken, {
    historyId: opts.historyId,
    maxResults: opts.maxResults,
  });

  const messages: RawMessageLike[] = [];
  // Sequential with a small delay: Gmail per-user quotas are easy to trip.
  for (const id of listing.ids) {
    messages.push(await fetchMessage(opts.accessToken, id));
    await new Promise((r) => setTimeout(r, 40));
  }

  return {
    messages,
    historyId: listing.historyId,
    fullResync: listing.fullResync,
  };
}

/** The Gmail source as the pipeline sees it. Requires an access token. */
export function createGmailSource(getAccessToken: () => Promise<string>): MailSource {
  return {
    id: "gmail",
    label: "Gmail",
    description: "Live mailbox over the Gmail API (read-only).",
    async fetchMessages(): Promise<RawMessageLike[]> {
      const accessToken = await getAccessToken();
      const { messages } = await fetchGmailMessages({ accessToken });
      return messages;
    },
  };
}
