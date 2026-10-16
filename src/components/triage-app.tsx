"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { DailyDigest, Persona, PriorityBand, TriagedMail } from "@/lib/types";
import type { EngineStatus } from "@/lib/pipeline/engine";
import type { Stats } from "@/lib/db/repo";
import {
  archiveAction,
  deleteAction,
  emptyTrashAction,
  overridePriorityAction,
  purgeAction,
  reseedAction,
  restoreAction,
  syncAction,
  testConnectionAction,
  unarchiveAction,
  type ActionResult,
} from "@/app/actions";
import type { SourceStatus } from "@/lib/sources";
import { BriefPane } from "./brief-pane";
import { MailList } from "./mail-list";
import { PersonaRail } from "./persona-rail";
import { BandBadge } from "./band-badge";

/**
 * The triage shell: persona rail · priority queue · intelligence brief.
 *
 * The queue is computed on the server and passed down whole; filtering happens
 * client-side so lane switching is instant. Mutations go back through server
 * actions and revalidate, so the server stays the single source of truth.
 *
 * Keyboard-first (PLAN.md §10.5): j/k move, e archive, 1-4 re-rank, / filter.
 */

const BANDS: PriorityBand[] = ["P0", "P1", "P2", "P3"];

export function TriageApp({
  mails,
  noise,
  archived,
  trash,
  stateCounts,
  stats,
  digest,
  status,
  personas,
  ownerEmail,
  sourceId,
  sources,
  initialNotice,
}: {
  mails: TriagedMail[];
  noise: TriagedMail[];
  archived: TriagedMail[];
  trash: TriagedMail[];
  stateCounts: { active: number; archived: number; trash: number };
  stats: Stats;
  digest: DailyDigest;
  status: EngineStatus;
  personas: Persona[];
  ownerEmail: string;
  sourceId: string;
  sources: SourceStatus[];
  initialNotice: ActionResult | null;
}) {
  const router = useRouter();
  const [lane, setLane] = useState<string>("focus");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<ActionResult | null>(initialNotice);

  // ---- lane contents ------------------------------------------------------

  const quarantined = useMemo(
    () =>
      mails.filter(
        (m) =>
          m.decision?.trust.verdict === "suspicious" ||
          m.decision?.trust.verdict === "phishing",
      ),
    [mails],
  );

  const ranked = useMemo(
    () =>
      mails.filter(
        (m) =>
          m.decision?.trust.verdict !== "suspicious" &&
          m.decision?.trust.verdict !== "phishing",
      ),
    [mails],
  );

  const laneMails = useMemo(() => {
    if (lane === "noise") return noise;
    if (lane === "quarantine") return quarantined;
    if (lane === "archived") return archived;
    if (lane === "trash") return trash;
    if (lane === "focus") {
      return ranked.filter(
        (m) =>
          m.decision &&
          (m.decision.priorityBand === "P0" ||
            m.decision.priorityBand === "P1" ||
            m.decision.requiresAction),
      );
    }
    if (lane === "all") return ranked;
    return ranked.filter((m) => m.decision?.persona.primary === lane);
  }, [lane, noise, quarantined, ranked, archived, trash]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return laneMails;
    return laneMails.filter((m) => {
      const hay = [
        m.message.subject,
        m.message.from.name ?? "",
        m.message.from.email,
        m.decision?.intelligence.tldr ?? "",
        m.message.snippet,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [laneMails, query]);

  // ---- selection follows the lane ----------------------------------------

  /**
   * Selection is *derived*, not stored.
   *
   * If the explicit selection is not in the current lane, fall back to the first
   * visible mail. Storing it in state via an effect would leave `null` during the
   * server render, so the brief pane would paint empty and only fill in after
   * hydration. Deriving it means the first paint already has content.
   */
  const effectiveId = useMemo(() => {
    if (visible.length === 0) return null;
    if (selectedId && visible.some((m) => m.message.id === selectedId)) {
      return selectedId;
    }
    return visible[0].message.id;
  }, [visible, selectedId]);

  const selected = useMemo(
    () => visible.find((m) => m.message.id === effectiveId) ?? null,
    [visible, effectiveId],
  );

  // ---- actions ------------------------------------------------------------

  const run = useCallback(
    (fn: () => Promise<ActionResult | void>, showResult = false) => {
      startTransition(async () => {
        const result = await fn();
        if (showResult) {
          setNotice(
            result ?? { ok: true, message: "Done." },
          );
        }
        router.refresh();
      });
    },
    [router],
  );

  const archive = useCallback(
    (id: string) => run(() => archiveAction(id)),
    [run],
  );

  const override = useCallback(
    (id: string, band: PriorityBand) =>
      run(() => overridePriorityAction(id, band)),
    [run],
  );

  const unarchive = useCallback(
    (id: string) => run(() => unarchiveAction(id)),
    [run],
  );

  /** Move to trash. Recoverable from the Trash lane, so no confirmation. */
  const moveToTrash = useCallback(
    (id: string) => run(() => deleteAction(id)),
    [run],
  );

  const restore = useCallback(
    (id: string) => run(() => restoreAction(id)),
    [run],
  );

  /** Irreversible: the brief pane confirms before calling this. */
  const purge = useCallback((id: string) => run(() => purgeAction(id)), [run]);

  const emptyTrash = useCallback(
    () => run(() => emptyTrashAction(), true),
    [run],
  );

  const sync = useCallback((reset: boolean) => run(() => syncAction(reset), true), [run]);

  const testConnection = useCallback(
    () => run(() => testConnectionAction(), true),
    [run],
  );

  const reseed = useCallback(
    (forceHeuristic: boolean) => run(() => reseedAction(forceHeuristic), true),
    [run],
  );

  const move = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const index = visible.findIndex((m) => m.message.id === effectiveId);
      const next = Math.min(
        visible.length - 1,
        Math.max(0, (index === -1 ? 0 : index) + delta),
      );
      setSelectedId(visible[next].message.id);
      document
        .querySelector(`[data-mail-id="${visible[next].message.id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    },
    [visible, effectiveId],
  );

  // ---- keyboard -----------------------------------------------------------

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (e.key === "Escape" && typing) {
        (target as HTMLInputElement).blur();
        setQuery("");
        return;
      }
      if (typing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "e" && effectiveId) {
        e.preventDefault();
        archive(effectiveId);
      } else if ((e.key === "#" || e.key === "Backspace") && effectiveId) {
        e.preventDefault();
        moveToTrash(effectiveId);
      } else if (e.key === "/") {
        e.preventDefault();
        document
          .querySelector<HTMLInputElement>("[data-mail-search]")
          ?.focus();
      } else if (/^[1-4]$/.test(e.key) && effectiveId) {
        // Keys 1-4 map to P0-P3.
        e.preventDefault();
        override(effectiveId, BANDS[Number(e.key) - 1]);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [move, archive, moveToTrash, override, effectiveId]);

  // ---- rail counts --------------------------------------------------------

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of ranked) {
      const p = m.decision?.persona.primary;
      if (p) out[p] = (out[p] ?? 0) + 1;
    }
    out.__noise = noise.length;
    out.__quarantine = quarantined.length;
    out.__archived = stateCounts.archived;
    out.__trash = stateCounts.trash;
    return out;
  }, [ranked, noise, quarantined, stateCounts]);

  const title =
    lane === "focus"
      ? "Focus"
      : lane === "all"
        ? "Everything"
        : lane === "noise"
          ? "Noise & digest"
          : lane === "quarantine"
            ? "Quarantine"
            : lane === "archived"
              ? "Archived"
              : lane === "trash"
                ? "Trash"
                : (personas.find((p) => p.id === lane)?.name ?? lane);

  const subtitle =
    lane === "focus"
      ? "Priority 0 and 1, plus anything with an open ask"
      : lane === "noise"
        ? `${digest.totalNoise} collapsed today — ${digest.totalActionable} high-priority still needed you`
        : lane === "quarantine"
          ? "Suspicious and phishing mail — links are defanged"
          : lane === "archived"
            ? "Filed away locally. Your Gmail copy is untouched."
            : lane === "trash"
              ? "Deleted locally and recoverable. Gmail is untouched."
              : `${visible.length} ranked in this lane`;

  /** Archived and trash are filing lanes: the row actions invert. */
  const listMode =
    lane === "trash" ? "trash" : lane === "archived" ? "archived" : "active";

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <PersonaRail
        personas={personas}
        lane={lane}
        onLane={setLane}
        counts={counts}
        bandCounts={stats.byBand}
        status={status}
        totalMails={stats.total}
        busy={pending}
        sourceId={sourceId}
        sources={sources}
        notice={notice}
        stateCounts={stateCounts}
        onDismissNotice={() => setNotice(null)}
        onSync={sync}
        onTestConnection={testConnection}
        onReseed={reseed}
        onEmptyTrash={emptyTrash}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* status strip — cost and trace health, always visible */}
        <header className="flex items-center gap-4 border-b border-border px-4 py-2 font-mono text-[10px] text-muted-foreground/60">
          <span className="text-muted-foreground/80">{ownerEmail}</span>
          <span className="ml-auto flex items-center gap-3">
            {BANDS.map((b) => (
              <span key={b} className="flex items-center gap-1.5">
                <BandBadge band={b} />
                <span className="tabular-nums">{stats.byBand[b]}</span>
              </span>
            ))}
            <span className="text-muted-foreground/30">|</span>
            <span>
              {stats.byEngine.find((e) => e.engine === "deepseek")?.count
                ? `deepseek · ${stats.byEngine.find((e) => e.engine === "deepseek")?.count}`
                : "rules only"}
            </span>
            <span className="text-muted-foreground/30">|</span>
            <span>${stats.totalCostUsd.toFixed(4)}</span>
            <span className="text-muted-foreground/30">|</span>
            <span title="Every decision whose arithmetic reconciles exactly">
              traces ok {(stats.total - stats.inconsistent).toFixed(0)}/{stats.total}
            </span>
          </span>
        </header>

        {/*
          `grid-rows-[minmax(0,1fr)]` is load-bearing: grid rows default to
          `auto`, which sizes to content. Without an explicit fractional row the
          panes grow past the viewport, their `overflow-y-auto` never engages,
          and the outer `overflow-hidden` silently clips unreachable mail.
        */}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(19rem,26rem)_1fr] grid-rows-[minmax(0,1fr)]">
          <MailList
            mails={visible}
            selectedId={effectiveId}
            onSelect={setSelectedId}
            query={query}
            onQueryChange={setQuery}
            title={title}
            subtitle={subtitle}
            mode={listMode}
            onArchive={archive}
            onUnarchive={unarchive}
            onTrash={moveToTrash}
            onRestore={restore}
            onPurge={purge}
            busy={pending}
            emptyMessage={
              lane === "quarantine"
                ? "No suspicious mail. Phishing heuristics found nothing to quarantine."
                : lane === "noise"
                  ? "Nothing was filtered out today."
                  : lane === "archived"
                    ? "Nothing archived yet. Press e on a message to file it away."
                    : lane === "trash"
                      ? "Trash is empty."
                      : query
                        ? `Nothing in ${title} matches “${query}”.`
                        : "Nothing in this lane needs you right now."
            }
            showBand={lane !== "noise"}
          />

          <BriefPane
            item={selected}
            mode={listMode}
            onArchive={archive}
            onUnarchive={unarchive}
            onTrash={moveToTrash}
            onRestore={restore}
            onPurge={purge}
            onOverride={override}
            busy={pending}
          />
        </div>
      </div>
    </div>
  );
}
