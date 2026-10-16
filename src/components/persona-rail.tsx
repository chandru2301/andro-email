"use client";

import {
  Archive,
  CircleAlert,
  CircleCheck,
  Command,
  Inbox,
  Loader2,
  Plug,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { PersonaIcon } from "./icons";
import { cn } from "@/lib/utils";
import { useState } from "react";
import type { Persona, PriorityBand } from "@/lib/types";
import type { EngineStatus } from "@/lib/pipeline/engine";
import type { SourceStatus } from "@/lib/sources";
import type { ActionResult } from "@/app/actions";
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

/**
 * The persona rail (PLAN.md §10.2) plus the two non-persona lanes: quarantine
 * and noise.
 *
 * A persona is a lens on the same queue, not a folder — switching lanes never
 * moves mail, it changes which mail you are looking at.
 *
 * The footer is deliberately explicit about two things the user must be able to
 * verify: *which engine is deciding* and *which mailbox is being read*.
 */

export type Lane = "focus" | "all" | "noise" | "quarantine" | string;

export function PersonaRail({
  personas,
  lane,
  onLane,
  counts,
  bandCounts,
  status,
  totalMails,
  busy,
  sourceId,
  sources,
  notice,
  stateCounts,
  onDismissNotice,
  onSync,
  onTestConnection,
  onReseed,
  onEmptyTrash,
}: {
  personas: Persona[];
  lane: Lane;
  onLane: (lane: Lane) => void;
  counts: Record<string, number>;
  bandCounts: Record<PriorityBand, number>;
  status: EngineStatus;
  totalMails: number;
  busy: boolean;
  sourceId: string;
  sources: SourceStatus[];
  notice: ActionResult | null;
  stateCounts: { active: number; archived: number; trash: number };
  onDismissNotice: () => void;
  onSync: (reset: boolean) => void;
  onTestConnection: () => void;
  onReseed: (forceHeuristic: boolean) => void;
  onEmptyTrash: () => void;
}) {
  const actionable = bandCounts.P0 + bandCounts.P1;
  const activeSource = sources.find((s) => s.id === sourceId);
  const imapAvailable = sources.some((s) => s.id === "imap" && s.available);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  return (
    <aside className="flex h-full w-[16.5rem] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex size-6 items-center justify-center rounded-md bg-primary text-background">
          <Inbox className="size-3.5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium leading-tight">
            Andro Email
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground/60">
            {totalMails} messages
          </div>
        </div>
      </div>

      {/* Non-persona lanes */}
      <nav className="px-2">
        <RailItem
          icon={<Zap className="size-3.5" />}
          label="Focus"
          hint={actionable > 0 ? String(actionable) : undefined}
          active={lane === "focus"}
          onClick={() => onLane("focus")}
        />
        <RailItem
          icon={<Inbox className="size-3.5" />}
          label="Everything"
          active={lane === "all"}
          onClick={() => onLane("all")}
        />
        <RailItem
          icon={<ShieldAlert className="size-3.5" />}
          label="Quarantine"
          hint={counts.__quarantine ? String(counts.__quarantine) : undefined}
          danger={Boolean(counts.__quarantine)}
          active={lane === "quarantine"}
          onClick={() => onLane("quarantine")}
        />
        <RailItem
          icon={<Search className="size-3.5" />}
          label="Noise"
          hint={counts.__noise ? String(counts.__noise) : undefined}
          active={lane === "noise"}
          onClick={() => onLane("noise")}
        />

        {/* Filing lanes. Divider makes it clear these are not personas. */}
        <div className="my-1.5 border-t border-sidebar-border/60" />

        <RailItem
          icon={<Archive className="size-3.5" />}
          label="Archived"
          hint={stateCounts.archived ? String(stateCounts.archived) : undefined}
          active={lane === "archived"}
          onClick={() => onLane("archived")}
        />
        <RailItem
          icon={<Trash2 className="size-3.5" />}
          label="Trash"
          hint={stateCounts.trash ? String(stateCounts.trash) : undefined}
          active={lane === "trash"}
          onClick={() => onLane("trash")}
        />
      </nav>

      <div className="mt-5 px-4 pb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">
        Personas
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {personas.map((p) => (
          <RailItem
            key={p.id}
            icon={<PersonaIcon name={p.icon} className="size-3.5" />}
            label={p.name}
            hint={counts[p.id] ? String(counts[p.id]) : undefined}
            active={lane === p.id}
            onClick={() => onLane(p.id)}
          />
        ))}
      </div>

      {/* Sync result — surfaced inline rather than as a transient toast, because
          a failed credential check is not something to auto-dismiss. */}
      {notice ? (
        <div className="border-t border-sidebar-border px-3 py-2.5">
          <div
            className={cn(
              "rounded-md border px-2.5 py-2",
              notice.ok
                ? "border-border bg-muted/40"
                : "border-destructive/40 bg-destructive/5",
            )}
          >
            <div className="flex items-start gap-1.5">
              {notice.ok ? (
                <CircleCheck className="mt-px size-3 shrink-0 text-muted-foreground" />
              ) : (
                <CircleAlert className="mt-px size-3 shrink-0 text-destructive" />
              )}
              <p
                className={cn(
                  "min-w-0 flex-1 text-[10px] leading-relaxed",
                  notice.ok ? "text-foreground/80" : "text-destructive",
                )}
              >
                {notice.message}
              </p>
              <button
                type="button"
                onClick={onDismissNotice}
                className="shrink-0 text-muted-foreground/40 hover:text-foreground"
                aria-label="Dismiss"
              >
                <X className="size-3" />
              </button>
            </div>
            {notice.detail ? (
              <p className="mt-1.5 max-h-24 overflow-y-auto break-words font-mono text-[9px] leading-relaxed text-muted-foreground/50">
                {notice.detail}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Engine + source */}
      <div className="space-y-2 border-t border-sidebar-border px-3 py-3">
        <div className="px-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 rounded-full",
                status.mode === "deepseek" ? "bg-primary" : "bg-warning",
              )}
            />
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              {status.mode === "deepseek" ? status.flashModel : "rules engine"}
            </span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/50">
            {status.mode === "deepseek"
              ? `Escalates to ${status.proModel} on low confidence or high stakes.`
              : "No API key — ranking comes from deterministic rules only."}
          </p>
        </div>

        <div className="border-t border-sidebar-border/60 px-1 pt-2">
          <div className="flex items-center gap-1.5">
            <Plug className="size-3 shrink-0 text-muted-foreground/60" />
            <span className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              {activeSource?.label ?? sourceId}
            </span>
          </div>
          <p className="mt-1 break-words text-[10px] leading-relaxed text-muted-foreground/50">
            {activeSource?.detail ?? "Unknown source."}
          </p>

          <div className="mt-2 flex flex-col gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="h-6 w-full justify-start px-1.5 text-[10px] text-muted-foreground/70 hover:text-foreground"
              onClick={() => onSync(false)}
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              {busy ? "Working…" : "Sync now"}
            </Button>

            {stateCounts.trash > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                className="h-6 w-full justify-start px-1.5 text-[10px] text-destructive/80 hover:text-destructive"
                onClick={() => setConfirmEmpty(true)}
                title="Permanently remove every trashed message from the local database"
              >
                <Trash2 className="size-3" />
                Empty trash ({stateCounts.trash})
              </Button>
            ) : null}

            {imapAvailable ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                className="h-6 w-full justify-start px-1.5 text-[10px] text-muted-foreground/70 hover:text-foreground"
                onClick={onTestConnection}
              >
                <Plug className="size-3" />
                Test connection
              </Button>
            ) : null}

            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="h-6 w-full justify-start px-1.5 text-[10px] text-muted-foreground/50 hover:text-foreground"
              onClick={() => onReseed(status.mode === "heuristic")}
              title="Wipe stored mail and reload the bundled fixture corpus"
            >
              <RefreshCw className="size-3" />
              Reset to fixtures
            </Button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 border-t border-sidebar-border px-4 py-2.5 font-mono text-[10px] text-muted-foreground/40">
        <Command className="size-3" />
        <span>K to jump</span>
        <span className="ml-auto">j / k</span>
      </div>

      <Dialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              Permanently delete {stateCounts.trash} trashed message
              {stateCounts.trash === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              This also removes their decisions and traces from the local
              database, and cannot be undone.
              <span className="mt-2 block text-foreground/70">
                Your Gmail mailbox is <strong>not</strong> affected — this app
                never writes to it. A future sync will re-import these messages.
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
                setConfirmEmpty(false);
                onEmptyTrash();
              }}
            >
              <Trash2 className="size-3" />
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function RailItem({
  icon,
  label,
  hint,
  active,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
        active
          ? "bg-sidebar-accent text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
      )}
    >
      <span className={cn("shrink-0", danger && "text-destructive")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? (
        <span
          className={cn(
            "shrink-0 font-mono text-[10px] tabular-nums",
            danger ? "text-destructive" : "text-muted-foreground/50",
          )}
        >
          {hint}
        </span>
      ) : null}
    </button>
  );
}
