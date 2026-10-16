import { PERSONAS } from "../personas";
import type { Message, PriorityBand, RawMessageLike } from "../types";

export type { RawMessageLike };
import { DEFAULT_OWNER_EMAIL, hasDeepSeekKey, PROMPT_VERSION } from "../config";
import {
  countThreadMessages,
  ensureAccount,
  getAnalysisState,
  getOwnerEmail,
  insertMessage,
  recordEvent,
  saveDecision,
  saveSignalBundle,
} from "../db/repo";
import { domainOf } from "../utils";
import { decide } from "./engine";
import { normalizeMessage, formatAddress } from "./normalize";
import { prescore } from "./prescorer";

/**
 * Pipeline orchestration (PLAN.md §12).
 *
 * sync → normalize → pre-score → decide → reconcile → persist
 *
 * Runs in-process with a small concurrency pool rather than a real queue. The
 * plan called for BullMQ; the reduced scope drops that infrastructure, and this
 * keeps the whole pipeline inspectable in a debugger.
 */

export type IngestProgress = {
  done: number;
  total: number;
  subject: string;
  band: PriorityBand | null;
};

export type IngestResult = {
  total: number;
  analyzed: number;
  skipped: number;
  sentSkipped: number;
  fallbacks: number;
  escalations: number;
  byBand: Record<PriorityBand, number>;
  durationMs: number;
  engine: "deepseek" | "heuristic";
};

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Domains the owner has a real relationship with.
 *
 * Two sources: the persona definitions, and any domain that appears more than
 * once in the corpus (a repeat correspondent is a relationship even if it is not
 * on a list).
 */
export function inferKnownDomains(raws: RawMessageLike[]): string[] {
  const domains = new Set<string>();
  for (const persona of PERSONAS) {
    for (const pattern of persona.senderPatterns) domains.add(pattern.toLowerCase());
  }

  const counts = new Map<string, number>();
  for (const raw of raws) {
    if (raw.isFromMe) continue;
    const d = domainOf(raw.from.email);
    if (!d) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  for (const [d, n] of counts) {
    if (n > 1) domains.add(d);
  }

  return Array.from(domains);
}

/** A short digest of earlier messages in the thread, for model context. */
function buildThreadDigest(prior: Message[]): string {
  if (prior.length === 0) return "";
  return prior
    .slice(-4)
    .map((m) => {
      const who = m.isFromMe ? "You" : formatAddress(m.from);
      return `- ${m.receivedAt.slice(0, 10)} ${who}: ${m.snippet.slice(0, 140)}`;
    })
    .join("\n");
}

/** Mark which messages arrived after the owner had already replied. */
function computeThreadParticipation(
  raws: RawMessageLike[],
): Map<string, boolean> {
  const byThread = new Map<string, RawMessageLike[]>();
  for (const raw of raws) {
    const list = byThread.get(raw.gmailThreadId) ?? [];
    list.push(raw);
    byThread.set(raw.gmailThreadId, list);
  }

  const result = new Map<string, boolean>();

  for (const list of byThread.values()) {
    const ordered = [...list].sort((a, b) =>
      a.receivedAt.localeCompare(b.receivedAt),
    );
    let ownerHasSpoken = false;
    for (const raw of ordered) {
      result.set(raw.gmailMessageId, ownerHasSpoken && !raw.isFromMe);
      if (raw.isFromMe) ownerHasSpoken = true;
    }
  }

  return result;
}

export async function ingestMessages(
  raws: RawMessageLike[],
  opts: {
    ownerEmail?: string;
    onProgress?: (p: IngestProgress) => void;
    concurrency?: number;
    /** Skip the model even if a key is present. */
    forceHeuristic?: boolean;
    /**
     * Re-use existing decisions when the content hash and prompt version match.
     * Default true — re-syncing a mailbox should not re-pay for old mail.
     */
    skipAlreadyAnalyzed?: boolean;
  } = {},
): Promise<IngestResult> {
  const startedAt = Date.now();

  const ownerEmail =
    opts.ownerEmail ?? getOwnerEmail() ?? DEFAULT_OWNER_EMAIL;
  ensureAccount(ownerEmail, "mock");

  const knownDomains = inferKnownDomains(raws);
  const participation = computeThreadParticipation(raws);

  const ordered = [...raws].sort((a, b) =>
    a.receivedAt.localeCompare(b.receivedAt),
  );

  // Normalize + persist everything first, including sent mail (which is needed
  // for thread participation but never analyzed or ranked).
  const normalized: Message[] = [];
  for (const raw of ordered) {
    const message = normalizeMessage(raw, {
      priorUserReplied: participation.get(raw.gmailMessageId) ?? false,
    });
    insertMessage(message);
    normalized.push(message);
  }

  const toAnalyze = normalized.filter((m) => !m.isFromMe);

  const byBand: Record<PriorityBand, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  let fallbacks = 0;
  let escalations = 0;
  let skipped = 0;
  let engine: "deepseek" | "heuristic" = "heuristic";
  let done = 0;

  const analysisState =
    opts.skipAlreadyAnalyzed === false ? new Map() : getAnalysisState();

  /**
   * Which engine *should* produce a decision right now. If a decision was
   * produced by a different one — most importantly, if it fell back to rules
   * because the API key was broken and the key has since been fixed — the
   * message is re-analyzed rather than skipped.
   */
  const expectedEngine: "deepseek" | "heuristic" =
    opts.forceHeuristic || !hasDeepSeekKey() ? "heuristic" : "deepseek";

  await mapPool(toAnalyze, opts.concurrency ?? 4, async (message) => {
    try {
      // Idempotency: unchanged content, same prompt version and same engine
      // means the stored decision is still valid. Re-running would cost money
      // to produce an identical answer.
      const previous = analysisState.get(message.id);
      if (
        previous &&
        previous.contentHash === message.contentHash &&
        previous.promptVersion === PROMPT_VERSION &&
        previous.engine === expectedEngine
      ) {
        skipped += 1;
        done += 1;
        opts.onProgress?.({
          done,
          total: toAnalyze.length,
          subject: message.subject,
          band: null,
        });
        return;
      }

      const threadCount = countThreadMessages(message.gmailThreadId);
      const bundle = prescore(message, {
        ownerEmail,
        knownDomains,
        threadCount,
      });
      saveSignalBundle(bundle);

      const priorInThread = normalized.filter(
        (m) =>
          m.gmailThreadId === message.gmailThreadId &&
          m.receivedAt < message.receivedAt,
      );

      const result = await decide({
        message,
        bundle,
        threadDigest: buildThreadDigest(priorInThread),
        knownDomains,
        ownerEmail,
        forceHeuristic: opts.forceHeuristic,
      });

      saveDecision(result.decision);
      byBand[result.decision.priorityBand] += 1;

      if (result.decision.engine === "deepseek") engine = "deepseek";
      if (result.fallbackReason) {
        fallbacks += 1;
        recordEvent("warn", result.fallbackReason, message.id);
      }
      if (result.escalationReason) {
        escalations += 1;
        recordEvent(
          "info",
          `Escalated to pro: ${result.escalationReason}`,
          message.id,
        );
      }

      done += 1;
      opts.onProgress?.({
        done,
        total: toAnalyze.length,
        subject: message.subject,
        band: result.decision.priorityBand,
      });
    } catch (error) {
      // One malformed message must never abort an entire sync. The message is
      // already persisted, so it simply appears un-analyzed rather than missing.
      const detail = error instanceof Error ? error.message : String(error);
      recordEvent("error", `Analysis failed: ${detail}`, message.id);
      done += 1;
      opts.onProgress?.({
        done,
        total: toAnalyze.length,
        subject: message.subject,
        band: null,
      });
    }
  });

  return {
    total: normalized.length,
    analyzed: toAnalyze.length - skipped,
    skipped,
    sentSkipped: normalized.length - toAnalyze.length,
    fallbacks,
    escalations,
    byBand,
    durationMs: Date.now() - startedAt,
    engine,
  };
}
