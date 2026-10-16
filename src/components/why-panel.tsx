import { cn, signed } from "@/lib/utils";
import { BAND_LABELS, type Decision, type SignalSource } from "@/lib/types";
import { BAND_STYLES } from "./band-badge";

/**
 * The Why? panel — the decision trace, rendered (PLAN.md §10.5).
 *
 * Three properties make this trustworthy rather than magical, and all three are
 * visible here:
 *
 *   1. The arithmetic is SHOWN, not implied: `72 + 4 + 11 = 87 → P1`.
 *   2. The model's contribution is BOUNDED (±15) and visually separated from
 *      deterministic fact.
 *   3. Every line carries a SOURCE tag, so "the header said this" is
 *      distinguishable from "the model inferred this".
 *
 * Nothing here is invented at render time. Every row comes from the persisted
 * trace, which is why the panel still explains a decision made last week under
 * an older prompt.
 */

const SOURCE_LABELS: Record<SignalSource, string> = {
  headers: "header",
  "text-rules": "text rule",
  "thread-history": "thread history",
  contacts: "contacts",
  store: "store",
  model: "model",
};

function SourceTag({ source }: { source: SignalSource }) {
  return (
    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
      {SOURCE_LABELS[source] ?? source}
    </span>
  );
}

function Term({
  value,
  label,
  emphasis,
}: {
  value: number;
  label: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex flex-col items-center">
      <span
        className={cn(
          "font-mono text-xl tabular-nums leading-none",
          emphasis ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {value}
      </span>
      <span className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
        {label}
      </span>
    </div>
  );
}

function Operator() {
  return (
    <span className="pb-4 font-mono text-sm text-muted-foreground/50">+</span>
  );
}

export function WhyPanel({
  decision,
  className,
}: {
  decision: Decision;
  className?: string;
}) {
  const t = decision.trace;
  const positive = t.evidence.filter((e) => e.weight > 0);
  const negative = t.evidence.filter((e) => e.weight < 0);

  return (
    <div className={cn("flex flex-col", className)}>
      {/* ---- arithmetic header ------------------------------------------- */}
      <div className="border-b border-border px-5 py-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-medium">
            Why{" "}
            <span className={cn("font-mono", BAND_STYLES[t.band].text)}>
              {t.band}
            </span>
            ?
          </h3>
          <span className="text-[11px] text-muted-foreground">
            {BAND_LABELS[t.band]}
          </span>
        </div>

        <div className="flex items-end gap-3">
          <Term value={t.deterministicScore} label="deterministic" />
          <Operator />
          <Term value={t.personaBias} label="persona" />
          <Operator />
          <Term value={t.modelAdjustment} label="model" />
          <span className="pb-4 font-mono text-sm text-muted-foreground/50">
            =
          </span>
          <Term value={t.finalScore} label="final" emphasis />
          <span className="pb-3 font-mono text-xs text-muted-foreground/50">
            →
          </span>
          <span
            className={cn(
              "pb-3.5 font-mono text-lg leading-none",
              BAND_STYLES[t.band].text,
            )}
          >
            {t.band}
          </span>
        </div>

        {!t.arithmeticOk ? (
          <p className="mt-3 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            The raw sum was clamped to the 0–100 range, so the displayed terms do
            not add up exactly.
          </p>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ---- evidence ---------------------------------------------------- */}
        <section className="border-b border-border px-5 py-4">
          <h4 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
            Evidence · deterministic
          </h4>

          {t.evidence.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No deterministic signals fired for this message.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {[...positive, ...negative].map((e, i) => (
                <li key={`${e.signal}-${i}`} className="flex items-start gap-3">
                  <span
                    className={cn(
                      "w-9 shrink-0 pt-px text-right font-mono text-xs tabular-nums",
                      e.weight > 0
                        ? "text-foreground"
                        : "text-muted-foreground/60",
                    )}
                  >
                    {signed(e.weight)}
                  </span>
                  <span className="min-w-0 flex-1 text-xs leading-relaxed text-foreground/90">
                    {e.label}
                    {e.value && e.value !== e.label ? (
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/60">
                        {e.value}
                      </span>
                    ) : null}
                  </span>
                  <SourceTag source={e.source} />
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
              Sum, clamped to 0–100
            </span>
            <span className="font-mono text-xs tabular-nums">
              {t.deterministicScore}
            </span>
          </div>
        </section>

        {/* ---- persona bias ------------------------------------------------ */}
        <section className="border-b border-border px-5 py-4">
          <h4 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
            Persona · {decision.persona.primary}
          </h4>
          <p className="-mt-2 mb-3 font-mono text-[10px] text-muted-foreground/40">
            capped at ±8
          </p>

          {t.personaBiasDetail.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              This persona applies no bias to the signals present.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {t.personaBiasDetail.map((d) => (
                <li key={d.factor} className="flex items-start gap-3">
                  <span className="w-9 shrink-0 pt-px text-right font-mono text-xs tabular-nums text-foreground">
                    {signed(d.delta)}
                  </span>
                  <span className="min-w-0 flex-1 text-xs leading-relaxed text-foreground/90">
                    {d.reason}
                    <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground/60">
                      {d.factor}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
              Persona bias
            </span>
            <span className="font-mono text-xs tabular-nums">
              {signed(t.personaBias)}
            </span>
          </div>
        </section>

        {/* ---- model ------------------------------------------------------- */}
        <section className="px-5 py-4">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
              Model · {t.model}
            </h4>
            <span className="font-mono text-[10px] text-muted-foreground/60">
              capped at ±15
            </span>
          </div>

          {t.adjustments.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              The model made no adjustment — the deterministic score stood.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {t.adjustments.map((a, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span
                    className={cn(
                      "w-9 shrink-0 pt-px text-right font-mono text-xs tabular-nums",
                      a.delta > 0
                        ? "text-foreground"
                        : "text-muted-foreground/60",
                    )}
                  >
                    {signed(a.delta)}
                  </span>
                  <span className="min-w-0 flex-1 text-xs leading-relaxed text-foreground/90">
                    {a.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
              Model adjustment
              {Math.abs(t.modelAdjustment) >= 15 ? " (clamped)" : ""}
            </span>
            <span className="font-mono text-xs tabular-nums">
              {signed(t.modelAdjustment)}
            </span>
          </div>
        </section>
      </div>

      {/* ---- footer -------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-5 py-3 font-mono text-[10px] text-muted-foreground/60">
        <span>
          judged{" "}
          {new Date(t.computedAt).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </span>
        <span>·</span>
        <span>prompt {t.promptVersion}</span>
        <span>·</span>
        <span>{t.cacheHit ? "cache hit" : "cache miss"}</span>
        {decision.engine === "heuristic" ? (
          <>
            <span>·</span>
            <span className="text-warning">
              rules engine — no model judgement applied
            </span>
          </>
        ) : null}
        {decision.escalatedToPro ? (
          <>
            <span>·</span>
            <span>escalated to pro</span>
          </>
        ) : null}
        {decision.isInconsistent ? (
          <>
            <span>·</span>
            <span className="text-destructive">
              model adjustment did not match its stated reasons
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
