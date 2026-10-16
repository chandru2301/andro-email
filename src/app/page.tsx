import { TriageApp } from "@/components/triage-app";
import {
  buildDigest,
  getMailStateCounts,
  getOwnerEmail,
  getStats,
  listNoise,
  listTriaged,
} from "@/lib/db/repo";
import { PERSONAS } from "@/lib/personas";
import { getEngineStatus } from "@/lib/pipeline/engine";
import { ensureSeeded } from "@/lib/seed";
import { activeSourceId, listSourceStatuses } from "@/lib/sources";

/**
 * The triage screen.
 *
 * Server-rendered so the queue, the traces and the stats are all resolved before
 * the first paint; the client component only handles lane switching, filtering
 * and keyboard navigation.
 *
 * `force-dynamic` because every request reads the local database — this app is a
 * live view of a mailbox, not a static page.
 */

export const dynamic = "force-dynamic";

export default async function Page() {
  // First run on an empty database pulls from the active source (IMAP when
  // configured, fixtures otherwise) so the app is never an empty shell.
  const initialSync = await ensureSeeded();

  const mails = listTriaged();
  const noise = listNoise();
  const archived = listTriaged({ state: "archived" });
  const trash = listTriaged({ state: "trash" });
  const stateCounts = getMailStateCounts();
  const stats = getStats();
  const status = getEngineStatus();
  const ownerEmail = getOwnerEmail();
  const digest = buildDigest(new Date().toISOString().slice(0, 10));

  return (
    <TriageApp
      mails={mails}
      noise={noise}
      archived={archived}
      trash={trash}
      stateCounts={stateCounts}
      stats={stats}
      digest={digest}
      status={status}
      personas={PERSONAS}
      ownerEmail={ownerEmail}
      sourceId={activeSourceId()}
      sources={listSourceStatuses()}
      initialNotice={
        initialSync && !initialSync.ok
          ? {
              ok: false,
              message: initialSync.message,
              detail: initialSync.detail,
            }
          : null
      }
    />
  );
}
