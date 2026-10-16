"use server";

import { revalidatePath } from "next/cache";
import {
  getTriagedMail,
  purgeAllDeleted,
  purgeMessage,
  saveFeedback,
  setArchived,
  setDeleted,
} from "@/lib/db/repo";
import { seedFromFixtures, syncMailbox } from "@/lib/seed";
import { testImapConnection } from "@/lib/sources/imap";
import type { PriorityBand } from "@/lib/types";

/**
 * Server actions for triage and mailbox sync.
 *
 * Every mutation revalidates the page so the server-rendered queue stays the
 * single source of truth — the client never holds a divergent copy of the inbox.
 */

export type ActionResult = {
  ok: boolean;
  message: string;
  detail?: string;
};

/**
 * Pull from the active source and analyze anything new or changed.
 *
 * Idempotent: unchanged mail under the same prompt version is not re-sent to
 * the model, so pressing this twice does not cost twice.
 */
export async function syncAction(reset: boolean): Promise<ActionResult> {
  const outcome = await syncMailbox({ reset, reanalyze: false });
  revalidatePath("/");
  return {
    ok: outcome.ok,
    message: outcome.message,
    detail: outcome.detail,
  };
}

/** Verify the IMAP credentials without syncing anything. */
export async function testConnectionAction(): Promise<ActionResult> {
  const result = await testImapConnection();
  return {
    ok: result.ok,
    message: result.message,
    detail: result.detail,
  };
}

/** Wipe stored mail and reload the fixture corpus (demo reset). */
export async function reseedAction(forceHeuristic: boolean): Promise<ActionResult> {
  const outcome = await seedFromFixtures({ force: true, forceHeuristic });
  revalidatePath("/");
  return {
    ok: outcome.ok,
    message: outcome.message,
    detail: outcome.detail,
  };
}

/**
 * Archive — hide from the queue, keep the message.
 *
 * Local only: the IMAP source is read-only, so nothing is filed in Gmail. The
 * flag persists, so a later sync will not put it back in the queue.
 */
export async function archiveAction(messageId: string): Promise<void> {
  setArchived(messageId, true);
  revalidatePath("/");
}

export async function unarchiveAction(messageId: string): Promise<void> {
  setArchived(messageId, false);
  revalidatePath("/");
}

/** Move to trash — recoverable until purged. Local only. */
export async function deleteAction(messageId: string): Promise<void> {
  setDeleted(messageId, true);
  revalidatePath("/");
}

export async function restoreAction(messageId: string): Promise<void> {
  setDeleted(messageId, false);
  revalidatePath("/");
}

/**
 * Delete permanently — removes the message and its decision and trace from the
 * local database. Irreversible, and still does not touch Gmail.
 */
export async function purgeAction(messageId: string): Promise<void> {
  purgeMessage(messageId);
  revalidatePath("/");
}

export async function emptyTrashAction(): Promise<ActionResult> {
  const removed = purgeAllDeleted();
  revalidatePath("/");
  return {
    ok: true,
    message: `Permanently removed ${removed} message${removed === 1 ? "" : "s"} from the local database.`,
  };
}

/**
 * Record a user's priority correction.
 *
 * The trace snapshot is stored alongside it, so a correction says *which
 * evidence* produced the wrong band — that is what makes this a targeted fix
 * rather than an anonymous thumbs-down (PLAN.md §10.5, §13).
 */
export async function overridePriorityAction(
  messageId: string,
  band: PriorityBand,
): Promise<void> {
  const triaged = getTriagedMail(messageId);
  if (!triaged?.decision) return;

  saveFeedback({
    messageId,
    field: "priority",
    aiValue: triaged.decision.priorityBand,
    userValue: band,
    traceSnapshot: triaged.decision.trace,
  });

  revalidatePath("/");
}

export async function feedbackPersonaAction(
  messageId: string,
  personaId: string,
): Promise<void> {
  const triaged = getTriagedMail(messageId);
  if (!triaged?.decision) return;

  saveFeedback({
    messageId,
    field: "persona",
    aiValue: triaged.decision.persona.primary,
    userValue: personaId,
    traceSnapshot: triaged.decision.trace,
  });

  revalidatePath("/");
}
