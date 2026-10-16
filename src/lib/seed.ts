import { OWNER, fixtureMessages } from "./fixtures/corpus";
import { clearAll, countMessages } from "./db/repo";
import { ingestMessages, type IngestResult } from "./pipeline/run";
import { activeSourceId, getActiveSource } from "./sources";
import { imapConfig } from "./sources/imap";

/**
 * Mailbox sync.
 *
 * One entry point for both sources. When IMAP is configured it is what runs;
 * otherwise the fixture corpus keeps the app runnable with no credentials — so
 * the decision engine, the trace and the UI are always demonstrable, and the
 * real-mailbox path is a configuration change rather than a code change.
 */

export type SyncOutcome = {
  ok: boolean;
  source: string;
  message: string;
  detail?: string;
  result: IngestResult | null;
};

export async function syncMailbox(
  opts: {
    /** Wipe stored mail first. Use when switching mailboxes. */
    reset?: boolean;
    forceHeuristic?: boolean;
    /** Re-run the model even when nothing changed. */
    reanalyze?: boolean;
  } = {},
): Promise<SyncOutcome> {
  const sourceId = activeSourceId();

  if (opts.reset) clearAll();

  let raw;
  try {
    raw = await getActiveSource().fetchMessages();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      source: sourceId,
      message:
        sourceId === "imap"
          ? "Could not read the mailbox over IMAP."
          : "Could not load the fixture corpus.",
      detail,
      result: null,
    };
  }

  if (raw.length === 0) {
    return {
      ok: true,
      source: sourceId,
      message: "The mailbox is empty — nothing to analyze.",
      result: null,
    };
  }

  const ownerEmail =
    sourceId === "imap" ? (imapConfig()?.user ?? OWNER.email) : OWNER.email;

  try {
    const result = await ingestMessages(raw, {
      ownerEmail,
      forceHeuristic: opts.forceHeuristic,
      skipAlreadyAnalyzed: !opts.reanalyze,
      concurrency: sourceId === "imap" ? 3 : 4,
    });

    const parts = [`${result.total} fetched`];
    if (result.skipped) parts.push(`${result.skipped} unchanged`);
    if (result.analyzed) parts.push(`${result.analyzed} analyzed`);
    if (result.fallbacks) parts.push(`${result.fallbacks} fell back to rules`);

    return {
      ok: true,
      source: sourceId,
      message: parts.join(" · "),
      result,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      source: sourceId,
      message: "Sync failed while analyzing messages.",
      detail,
      result: null,
    };
  }
}

/** Kept for callers that just want the old behaviour. */
export async function seedFromFixtures(
  opts: { force?: boolean; forceHeuristic?: boolean } = {},
): Promise<SyncOutcome> {
  if (!opts.force && countMessages() > 0) {
    return {
      ok: true,
      source: "mock",
      message: "Database already contains messages.",
      result: null,
    };
  }
  if (!opts.force) return syncMailbox({ forceHeuristic: opts.forceHeuristic });
  // Explicit reseed always comes from fixtures so the demo state is reachable
  // even when a real mailbox is configured.
  clearAll();
  const result = await ingestMessages(fixtureMessages, {
    ownerEmail: OWNER.email,
    forceHeuristic: opts.forceHeuristic,
    skipAlreadyAnalyzed: false,
    concurrency: 4,
  });
  return {
    ok: true,
    source: "mock",
    message: `Reseeded from fixtures: ${result.total} messages.`,
    result,
  };
}

/**
 * Idempotent first-run: only syncs when nothing is stored.
 *
 * Deliberately does NOT swallow IMAP failures — the caller surfaces them rather
 * than silently showing an empty inbox.
 */
export async function ensureSeeded(): Promise<SyncOutcome | null> {
  if (countMessages() > 0) return null;
  return syncMailbox();
}
