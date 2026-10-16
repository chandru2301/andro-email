import { createHash } from "node:crypto";
import type { Address, Message, RawMessageLike } from "../types";

/**
 * Normalization: turn raw mail into the sanitized plain text that is safe to
 * store and safe to send to a model.
 *
 * Two jobs, in order:
 *   1. Remove anything that is not content — HTML, tracking, quoted history,
 *      signature blocks. This is a *privacy* boundary (PLAN.md §9.1).
 *   2. Reduce the body to something whose tokens are worth paying for.
 */

const MAX_BODY_CHARS = 12_000;

/** Strip tags and decode the handful of entities that actually matter. */
export function stripHtml(input: string): string {
  if (!/<[a-z!/][\s\S]*>/i.test(input)) return input;
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

/**
 * Remove quoted replies. We keep the frontier message only: thread context is
 * supplied separately as a digest, so re-sending the whole history each time
 * would pay for the same tokens repeatedly.
 */
export function stripQuotedReply(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^>/.test(trimmed)) break;
    // "On <date>, <person> wrote:" — the standard attribution line.
    if (/^On .{5,80}\bwrote:\s*$/i.test(trimmed)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(trimmed)) break;
    if (/^_{5,}$/.test(trimmed)) break;
    if (/^From:\s.+/i.test(trimmed) && out.length > 3) break;
    out.push(line);
  }

  return out.join("\n").trim();
}

/** Remove the signature block (everything after a "-- " separator). */
export function stripSignature(body: string): string {
  const match = body.match(/\n--\s*\n/);
  if (match && match.index !== undefined) {
    return body.slice(0, match.index).trim();
  }
  return body.trim();
}

export function normalizeWhitespace(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The full sanitization pipeline. Order matters: HTML first, then structure. */
export function sanitizeBody(raw: string): string {
  let body = stripHtml(raw);
  body = normalizeWhitespace(body);
  body = stripQuotedReply(body);
  body = stripSignature(body);
  body = normalizeWhitespace(body);
  if (body.length > MAX_BODY_CHARS) {
    body = `${body.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`;
  }
  return body;
}

export function extractLinks(body: string): string[] {
  const matches = body.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
  return Array.from(new Set(matches)).slice(0, 20);
}

export function contentHash(parts: {
  subject: string;
  from: string;
  body: string;
}): string {
  return createHash("sha256")
    .update(`${parts.from}\u0000${parts.subject}\u0000${parts.body}`)
    .digest("hex")
    .slice(0, 32);
}

export function snippetOf(body: string, max = 160): string {
  const firstLine =
    body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

/** Lowercase header lookup that tolerates casing differences. */
export function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

export type RawMessage = RawMessageLike;

export function normalizeMessage(
  raw: RawMessage,
  opts: { priorUserReplied: boolean },
): Message {
  const cleanBody = sanitizeBody(raw.body);
  return {
    id: raw.gmailMessageId,
    gmailMessageId: raw.gmailMessageId,
    gmailThreadId: raw.gmailThreadId,
    from: raw.from,
    to: raw.to,
    cc: raw.cc,
    subject: raw.subject,
    cleanBody,
    snippet: snippetOf(cleanBody),
    receivedAt: raw.receivedAt,
    labelIds: raw.labelIds,
    headers: raw.headers,
    hasAttachments: raw.hasAttachments,
    attachmentNames: raw.attachmentNames,
    isFromMe: raw.isFromMe,
    contentHash: contentHash({
      subject: raw.subject,
      from: raw.from.email,
      body: cleanBody,
    }),
    priorUserReplied: opts.priorUserReplied,
  };
}
