"use client";

import {
  Archive,
  Clock,
  ExternalLink,
  Flame,
  Info,
  Paperclip,
  ShieldAlert,
  Trash2,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import {
  BAND_LABELS,
  type PriorityBand,
  type TriagedMail,
} from "@/lib/types";
import { BandBadge } from "./band-badge";
import { WhyPanel } from "./why-panel";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import type { ListMode } from "./mail-list";

/**
 * The Intelligence Brief (PLAN.md §10.4).
 *
 * Shows what the mail actually wants, not what it says. The Why? tab is the
 * decision trace; the Original tab is the sanitized source. Three tabs is the
 * whole information architecture: conclusion, reasoning, evidence.
 */

/** Phishing mail must never render a live link (PLAN.md §8, layer 3). */
function defang(text: string): string {
  return text.replace(/https?:\/\//g, (m) =>
    m.startsWith("https") ? "hxxps" : "hxxp",
  );
}

const BANDS: PriorityBand[] = ["P0", "P1", "P2", "P3"];

export function BriefPane({
  item,
  mode,
  onArchive,
  onUnarchive,
  onTrash,
  onRestore,
  onPurge,
  onOverride,
  busy,
}: {
  item: TriagedMail | null;
  mode: ListMode;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onTrash: (id: string) => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  onOverride: (id: string, band: PriorityBand) => void;
  busy: boolean;
}) {
  const [tab, setTab] = useState("brief");
  const [confirmPurge, setConfirmPurge] = useState(false);

  if (!item) {
    return (
      <section className="flex h-full items-center justify-center bg-background px-8">
        <div className="max-w-xs text-center">
          <Info className="mx-auto size-4 text-muted-foreground/40" />
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground/50">
            Select a message to see its brief, the reasoning behind its priority,
            and the original text.
          </p>
        </div>
      </section>
    );
  }

  const { message, decision, threadCount } = item;
  const quarantined =
    decision?.trust.verdict === "suspicious" ||
    decision?.trust.verdict === "phishing";
  const body = quarantined ? defang(message.cleanBody) : message.cleanBody;

  return (
    <section className="flex h-full min-w-0 flex-col bg-background">
      {/* ---- header ------------------------------------------------------ */}
      <header className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium leading-snug">
              {message.subject}
            </h2>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {message.from.name
                ? `${message.from.name} <${message.from.email}>`
                : message.from.email}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground/50">
              <span>{formatDate(message.receivedAt)}</span>
              <span>{relativeTime(message.receivedAt)} ago</span>
              {threadCount > 1 ? <span>{threadCount} in thread</span> : null}
              {decision ? (
                <span>read {decision.intelligence.readingTimeSeconds}s</span>
              ) : null}
              {message.hasAttachments ? (
                <span className="flex items-center gap-1">
                  <Paperclip className="size-2.5" />
                  {message.attachmentNames.join(", ")}
                </span>
              ) : null}
            </div>
          </div>

          {/*
            Labelled actions rather than bare icons: the whole point is that
            filing should be obvious. Nothing here writes to Gmail — the IMAP
            source is read-only — so each control says what it does locally.
          */}
          <div className="flex shrink-0 items-center gap-1">
            {mode === "active" ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="h-7 gap-1.5 px-2 text-[11px]"
                  onClick={() => onArchive(message.id)}
                  title="Hide from the queue, keep the message (e)"
                >
                  <Archive className="size-3" />
                  Archive
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:border-destructive/50 hover:text-destructive"
                  onClick={() => onTrash(message.id)}
                  title="Move to trash — recoverable (#)"
                >
                  <Trash2 className="size-3" />
                  Delete
                </Button>
              </>
            ) : null}

            {mode === "archived" ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="h-7 gap-1.5 px-2 text-[11px]"
                  onClick={() => onUnarchive(message.id)}
                  title="Put this back in the queue"
                >
                  <Undo2 className="size-3" />
                  Restore
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:border-destructive/50 hover:text-destructive"
                  onClick={() => onTrash(message.id)}
                  title="Move to trash — recoverable"
                >
                  <Trash2 className="size-3" />
                  Delete
                </Button>
              </>
            ) : null}

            {mode === "trash" ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="h-7 gap-1.5 px-2 text-[11px]"
                  onClick={() => onRestore(message.id)}
                  title="Recover this message"
                >
                  <Undo2 className="size-3" />
                  Restore
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="h-7 gap-1.5 px-2 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmPurge(true)}
                  title="Remove permanently from the local database"
                >
                  <Flame className="size-3" />
                  Delete forever
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {/* priority + override */}
        {decision ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <BandBadge
              band={decision.priorityBand}
              score={decision.priorityScore}
            />
            <span className="text-[11px] text-muted-foreground/60">
              {BAND_LABELS[decision.priorityBand]}
            </span>

            <span className="ml-auto font-mono text-[10px] text-muted-foreground/40">
              override
            </span>
            <div className="flex gap-0.5">
              {BANDS.map((b) => (
                <button
                  key={b}
                  type="button"
                  disabled={busy}
                  onClick={() => onOverride(message.id, b)}
                  className={cn(
                    "rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                    b === decision.priorityBand
                      ? "border-foreground/40 text-foreground"
                      : "border-border text-muted-foreground/50 hover:border-foreground/30 hover:text-foreground",
                  )}
                  title={`Set priority to ${b} (teaches the trace)`}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-3 font-mono text-[10px] text-warning">
            not yet analyzed
          </p>
        )}
      </header>

      {/* ---- trust banner ------------------------------------------------ */}
      {decision && decision.trust.warnings.length > 0 ? (
        <div
          className={cn(
            "border-b px-5 py-3",
            quarantined
              ? "border-destructive/30 bg-destructive/5"
              : "border-border bg-muted/30",
          )}
        >
          <div className="flex items-start gap-2">
            <ShieldAlert
              className={cn(
                "mt-px size-3.5 shrink-0",
                quarantined ? "text-destructive" : "text-muted-foreground",
              )}
            />
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "font-mono text-[10px] uppercase tracking-wider",
                  quarantined ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {decision.trust.verdict} · risk {Math.round(decision.trust.riskScore)}
              </p>
              <ul className="mt-1.5 space-y-1">
                {decision.trust.warnings.map((w, i) => (
                  <li
                    key={i}
                    className="text-[11px] leading-relaxed text-foreground/80"
                  >
                    {w}
                  </li>
                ))}
              </ul>
              {quarantined ? (
                <p className="mt-1.5 text-[10px] text-muted-foreground/60">
                  Links are shown defanged and are not clickable.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* ---- tabs -------------------------------------------------------- */}
      <Tabs
        value={tab}
        onValueChange={setTab}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="mx-5 mt-3 w-fit">
          <TabsTrigger value="brief" className="text-xs">
            Brief
          </TabsTrigger>
          <TabsTrigger value="why" className="text-xs">
            Why?
          </TabsTrigger>
          <TabsTrigger value="original" className="text-xs">
            Original
          </TabsTrigger>
        </TabsList>

        {/* Brief */}
        <TabsContent
          value="brief"
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
          {!decision ? (
            <p className="text-xs text-muted-foreground">
              This message has not been analyzed yet.
            </p>
          ) : (
            <div className="space-y-5">
              <div>
                <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                  TL;DR
                </h4>
                <p className="text-[13px] leading-relaxed text-foreground/90">
                  {decision.intelligence.tldr}
                </p>
              </div>

              {decision.intelligence.asks.length > 0 ? (
                <div>
                  <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                    Asks
                  </h4>
                  <ul className="space-y-2">
                    {decision.intelligence.asks.map((ask, i) => (
                      <li key={i} className="flex items-start gap-2.5">
                        <span
                          aria-hidden
                          className="mt-0.5 size-3 shrink-0 rounded-[3px] border border-foreground/30"
                        />
                        <span className="min-w-0 flex-1 text-[13px] leading-snug text-foreground/90">
                          {ask.text}
                          {ask.due ? (
                            <span className="ml-2 font-mono text-[10px] text-warning">
                              due {ask.due}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {decision.intelligence.keyFacts.length > 0 ? (
                <div>
                  <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                    Key facts
                  </h4>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                    {decision.intelligence.keyFacts.map((f, i) => (
                      <div key={i} className="contents">
                        <dt className="text-[11px] text-muted-foreground">
                          {f.label}
                        </dt>
                        <dd className="font-mono text-[11px] text-foreground/90">
                          {f.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}

              <Entities decision={decision} />
            </div>
          )}
        </TabsContent>

        {/* Why — the decision trace */}
        <TabsContent value="why" className="min-h-0 flex-1 overflow-hidden">
          {decision ? (
            <WhyPanel decision={decision} className="h-full" />
          ) : (
            <p className="px-5 py-4 text-xs text-muted-foreground">
              No decision recorded for this message.
            </p>
          )}
        </TabsContent>

        {/* Original — sanitized source */}
        <TabsContent
          value="original"
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
          <div className="mb-3 flex items-center gap-2 font-mono text-[10px] text-muted-foreground/50">
            <Clock className="size-3" />
            <span>sanitized plain text · quoted history and signature removed</span>
          </div>
          <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-foreground/80">
            {body}
          </pre>
        </TabsContent>
      </Tabs>

      {/* Permanent delete is the one irreversible action, so it is the one that
          asks. "Delete" alone only moves to trash and stays recoverable. */}
      <Dialog open={confirmPurge} onOpenChange={setConfirmPurge}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Delete this message permanently?</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              This removes the message, its decision and its trace from the local
              database. It cannot be undone.
              <span className="mt-2 block text-foreground/70">
                Your Gmail copy is <strong>not</strong> affected — this app never
                writes to your mailbox.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm" className="text-xs">
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              className="text-xs"
              disabled={busy}
              onClick={() => {
                setConfirmPurge(false);
                onPurge(message.id);
              }}
            >
              <Flame className="size-3" />
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Entities({
  decision,
}: {
  decision: NonNullable<TriagedMail["decision"]>;
}) {
  const e = decision.intelligence.entities;
  const groups: { label: string; values: string[] }[] = [
    { label: "People", values: e.people },
    { label: "Organisations", values: e.orgs },
    { label: "Dates", values: e.dates },
    { label: "Money", values: e.money },
  ].filter((g) => g.values.length > 0);

  if (groups.length === 0 && e.links.length === 0) return null;

  return (
    <div>
      <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
        Extracted
      </h4>
      <div className="space-y-1.5">
        {groups.map((g) => (
          <div key={g.label} className="flex items-baseline gap-3">
            <span className="w-24 shrink-0 text-[11px] text-muted-foreground">
              {g.label}
            </span>
            <span className="min-w-0 flex-1 text-[11px] text-foreground/80">
              {g.values.join(", ")}
            </span>
          </div>
        ))}
        {e.links.length > 0 ? (
          <div className="flex items-baseline gap-3">
            <span className="w-24 shrink-0 text-[11px] text-muted-foreground">
              Links
            </span>
            <span className="min-w-0 flex-1 space-y-0.5">
              {e.links.map((l, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1 truncate font-mono text-[10px] text-muted-foreground/70"
                >
                  <ExternalLink className="size-2.5 shrink-0" />
                  <span className="truncate">
                    {decision.trust.isPhishing ? defang(l) : l}
                  </span>
                </span>
              ))}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
