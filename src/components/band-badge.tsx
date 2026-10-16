import { cn } from "@/lib/utils";
import { BAND_LABELS, type PriorityBand } from "@/lib/types";

/**
 * Priority is expressed in monochrome (PLAN.md §10.1).
 *
 * The whole visual language for urgency is a white-opacity ramp, so the app
 * stays black-and-white while still being scannable. Colour appears nowhere
 * here — only `--destructive` is reserved for danger, and it is used by the
 * quarantine UI, not by priority.
 */

export const BAND_STYLES: Record<
  PriorityBand,
  { rail: string; badge: string; text: string }
> = {
  P0: {
    rail: "rail-p0",
    badge: "bg-priority-p0 text-background font-semibold",
    text: "text-foreground",
  },
  P1: {
    rail: "rail-p1",
    badge: "border border-priority-p1 text-foreground",
    text: "text-foreground",
  },
  P2: {
    rail: "rail-p2",
    badge: "border border-priority-p2 text-muted-foreground",
    text: "text-muted-foreground",
  },
  P3: {
    rail: "rail-p3",
    badge: "border border-priority-p3 text-muted-foreground/70",
    text: "text-muted-foreground/70",
  },
};

export function BandBadge({
  band,
  score,
  className,
}: {
  band: PriorityBand;
  score?: number;
  className?: string;
}) {
  const style = BAND_STYLES[band];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] leading-none tabular-nums",
        style.badge,
        className,
      )}
      title={`${band} — ${BAND_LABELS[band]}`}
    >
      {band}
      {typeof score === "number" ? (
        <span className="opacity-70">{Math.round(score)}</span>
      ) : null}
    </span>
  );
}

/** The 2px vertical rail that encodes priority in the queue. */
export function PriorityRail({
  band,
  className,
}: {
  band: PriorityBand | null;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute left-0 top-0 h-full w-0.5",
        band ? BAND_STYLES[band].rail : "bg-transparent",
        className,
      )}
    />
  );
}
