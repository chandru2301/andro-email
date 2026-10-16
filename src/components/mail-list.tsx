"use client";

import {
  Archive,
  Flame,
  Paperclip,
  Search,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { cn, initials, relativeTime } from "@/lib/utils";
import type { TriagedMail } from "@/lib/types";
import { BandBadge, PriorityRail } from "./band-badge";
import { Input } from "./ui/input";

/**
 * The priority-ranked queue (PLAN.md §10.2).
 *
 * Ordering is done server-side by the decision pipeline; this component only
 * renders, handles selection, and exposes the filing actions.
 *
 * The row is a `div[role=button]`, not a `<button>`: the per-row archive/delete
 * controls have to live inside it, and nesting a button inside a button is
 * invalid HTML that browsers silently rewrite. `stopPropagation` on those
 * controls keeps a click from also selecting the row.
 */

export type ListMode = "active" | "archived" | "trash";

export function MailList({
  mails,
  selectedId,
  onSelect,
  query,
  onQueryChange,
  title,
  subtitle,
  mode,
  onArchive,
  onUnarchive,
  onTrash,
  onRestore,
  onPurge,
  busy,
  emptyMessage,
  showBand = true,
}: {
  mails: TriagedMail[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  title: string;
  subtitle: string;
  mode: ListMode;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onTrash: (id: string) => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  busy: boolean;
  emptyMessage: string;
  showBand?: boolean;
}) {
  function actionsFor(id: string) {
    if (mode === "trash") {
      return [
        { key: "restore", icon: Undo2, label: "Restore", run: () => onRestore(id) },
        {
          key: "purge",
          icon: Flame,
          label: "Delete forever",
          run: () => onPurge(id),
          danger: true,
        },
      ];
    }
    if (mode === "archived") {
      return [
        {
          key: "unarchive",
          icon: Undo2,
          label: "Move back to the queue",
          run: () => onUnarchive(id),
        },
        {
          key: "trash",
          icon: Trash2,
          label: "Move to trash",
          run: () => onTrash(id),
          danger: true,
        },
      ];
    }
    return [
      { key: "archive", icon: Archive, label: "Archive (e)", run: () => onArchive(id) },
      {
        key: "trash",
        icon: Trash2,
        label: "Move to trash (#)",
        run: () => onTrash(id),
        danger: true,
      },
    ];
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col border-r border-border bg-background">
      <header className="shrink-0 border-b border-border px-4 pb-3 pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">
            {mails.length}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/60">
          {subtitle}
        </p>

        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
          <Input
            data-mail-search
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter this lane…"
            className="h-7 pl-8 text-xs"
            aria-label="Filter messages"
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {mails.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="text-center text-xs leading-relaxed text-muted-foreground/50">
              {emptyMessage}
            </p>
          </div>
        ) : (
          <ul>
            {mails.map((item) => {
              const { message, decision } = item;
              const selected = message.id === selectedId;
              const quarantined =
                decision?.trust.verdict === "suspicious" ||
                decision?.trust.verdict === "phishing";
              const actions = actionsFor(message.id);

              return (
                <li key={message.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    data-mail-id={message.id}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelect(message.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(message.id);
                      }
                    }}
                    className={cn(
                      "group relative block w-full cursor-pointer border-b border-border/60 py-3 pl-4 pr-3 text-left transition-colors",
                      selected
                        ? "bg-accent"
                        : "hover:bg-accent/40 focus-visible:bg-accent/40",
                    )}
                  >
                    <PriorityRail
                      band={quarantined ? null : (decision?.priorityBand ?? null)}
                    />
                    {quarantined ? (
                      <span
                        aria-hidden
                        className="absolute left-0 top-0 h-full w-0.5 bg-destructive"
                      />
                    ) : null}

                    <div className="flex items-center gap-2">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-secondary font-mono text-[9px] text-muted-foreground">
                        {initials(message.from.email)}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-xs",
                          decision && decision.priorityBand === "P0"
                            ? "font-medium text-foreground"
                            : "text-foreground/80",
                        )}
                      >
                        {message.from.name ?? message.from.email}
                      </span>
                      {message.hasAttachments ? (
                        <Paperclip className="size-3 shrink-0 text-muted-foreground/40" />
                      ) : null}
                      {/* Timestamp swaps out for the actions on hover. */}
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/40 group-hover:opacity-0">
                        {relativeTime(message.receivedAt)}
                      </span>
                    </div>

                    {/* Row actions — hover or keyboard focus. */}
                    <div className="absolute right-2 top-2.5 flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100">
                      {actions.map((action) => (
                        <button
                          key={action.key}
                          type="button"
                          disabled={busy}
                          title={action.label}
                          aria-label={action.label}
                          onClick={(e) => {
                            e.stopPropagation();
                            action.run();
                          }}
                          className={cn(
                            "flex size-5 items-center justify-center rounded border border-border bg-background/90 transition-colors disabled:opacity-50",
                            action.danger
                              ? "text-muted-foreground hover:border-destructive/50 hover:text-destructive"
                              : "text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                          )}
                        >
                          <action.icon className="size-3" />
                        </button>
                      ))}
                    </div>

                    <div className="mt-1.5 flex items-start gap-2">
                      {showBand && decision ? (
                        <BandBadge
                          band={decision.priorityBand}
                          score={decision.priorityScore}
                        />
                      ) : null}
                      {quarantined ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-destructive">
                          <ShieldAlert className="size-2.5" />
                          {decision?.trust.verdict}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-foreground/90">
                        {message.subject}
                      </span>
                    </div>

                    <p className="mt-1 line-clamp-2 pl-0.5 text-[11px] leading-relaxed text-muted-foreground/60">
                      {decision?.intelligence.tldr || message.snippet}
                    </p>

                    {decision && decision.intelligence.asks.length > 0 ? (
                      <div className="mt-1.5 flex items-center gap-1.5 pl-0.5">
                        <span className="rounded border border-border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">
                          {decision.intelligence.asks.length} ask
                          {decision.intelligence.asks.length === 1 ? "" : "s"}
                        </span>
                        {decision.deadline ? (
                          <span className="flex items-center gap-1 font-mono text-[9px] text-warning">
                            <TriangleAlert className="size-2.5" />
                            {decision.deadline}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
