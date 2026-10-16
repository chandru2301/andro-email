import { getPersona } from "../personas";
import {
  bandForScore,
  clamp,
  type Decision,
  type DecisionTrace,
  type Message,
  type ModelDecision,
  type PersonaBiasDetail,
  type SignalBundle,
  type TraceAdjustment,
  type TrustVerdict,
} from "../types";
import { activeFactors } from "./prescorer";

/**
 * Trace reconciliation (PLAN.md §7.3).
 *
 * This module is the reason the trace is trustworthy rather than decorative.
 *
 * The model authors exactly one number that affects ranking: a list of itemized
 * `adjustments`. Everything else — the deterministic score, the persona bias,
 * the sum, and the band — is computed *here*. A model therefore cannot inflate
 * its own influence, and there is no code path to an unexplained score.
 */

/** The model's influence is capped in code, not by asking it to self-limit. */
export const MODEL_ADJUSTMENT_CAP = 15;

/**
 * Persona bias is capped too.
 *
 * Without this, a persona with high weights on every live factor contributes 15
 * points — the same as the entire model budget — and drives almost everything it
 * touches to P0. The cap keeps persona bias a *tilt* on the deterministic score
 * rather than a second scoring system. Deltas are scaled proportionally so the
 * itemized rows still sum exactly to the applied value.
 */
export const PERSONA_BIAS_CAP = 8;

function clampPersonaBias(
  detail: PersonaBiasDetail[],
  cap: number,
): PersonaBiasDetail[] {
  const total = detail.reduce((sum, d) => sum + d.delta, 0);
  if (Math.abs(total) <= cap || detail.length === 0) return detail;

  const factor = cap / Math.abs(total);
  const scaled = detail.map((d) => ({
    ...d,
    delta: Math.max(1, Math.round(Math.abs(d.delta) * factor)),
  }));

  // Absorb rounding drift into the largest entry so the rows sum to the cap.
  const drift = cap - scaled.reduce((sum, d) => sum + d.delta, 0);
  if (drift !== 0) {
    let largest = 0;
    for (let i = 1; i < scaled.length; i++) {
      if (scaled[i].delta > scaled[largest].delta) largest = i;
    }
    scaled[largest] = {
      ...scaled[largest],
      delta: Math.max(1, scaled[largest].delta + drift),
    };
  }

  return scaled;
}

export type ReconcileInput = {
  message: Message;
  bundle: SignalBundle;
  model: ModelDecision;
  engine: "deepseek" | "heuristic";
  modelId: string;
  promptVersion: string;
  cacheHit: boolean;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  latencyMs?: number;
};

/** Persona-specific ranking bias. Deterministic and server-owned. */
export function computePersonaBias(
  personaId: string,
  bundle: SignalBundle,
): { total: number; detail: PersonaBiasDetail[] } {
  const persona = getPersona(personaId);
  if (!persona) return { total: 0, detail: [] };

  const live = activeFactors(bundle);
  const detail: PersonaBiasDetail[] = [];

  const copy: Record<keyof typeof live, string> = {
    senderRelationship: "weights known senders higher",
    deadline: "weights deadlines higher",
    money: "weights money and contracts higher",
    replyNeeded: "weights open questions higher",
  };

  for (const key of Object.keys(live) as (keyof typeof live)[]) {
    if (!live[key]) continue;
    const delta = persona.priorityWeights[key];
    if (delta === 0) continue;
    detail.push({
      factor: key,
      delta,
      reason: `${persona.name} ${copy[key]}`,
    });
  }

  const clamped = clampPersonaBias(detail, PERSONA_BIAS_CAP);
  return {
    total: clamped.reduce((sum, d) => sum + d.delta, 0),
    detail: clamped,
  };
}

/**
 * Sum the itemized deltas and clamp. Deliberately ignores
 * `model.priority.modelAdjustment` for the *value* — we use the itemization as
 * the source of truth and compare the two to detect a self-inconsistent model.
 */
function resolveModelAdjustment(model: ModelDecision): {
  applied: number;
  itemizedSum: number;
  mismatched: boolean;
  adjustments: TraceAdjustment[];
} {
  const adjustments = model.priority.adjustments.filter(
    (a) => Number.isFinite(a.delta) && a.delta !== 0,
  );
  const itemizedSum = adjustments.reduce((sum, a) => sum + a.delta, 0);
  const claimed = model.priority.modelAdjustment;
  return {
    applied: clamp(itemizedSum, -MODEL_ADJUSTMENT_CAP, MODEL_ADJUSTMENT_CAP),
    itemizedSum,
    mismatched: Number.isFinite(claimed) && claimed !== itemizedSum,
    adjustments,
  };
}

export function reconcile(input: ReconcileInput): Decision {
  const { message, bundle, model } = input;

  const deterministicScore = bundle.baseScore;
  const { total: personaBias, detail: personaBiasDetail } = computePersonaBias(
    model.persona.primary,
    bundle,
  );

  const {
    applied: modelAdjustment,
    itemizedSum,
    mismatched,
    adjustments,
  } = resolveModelAdjustment(model);

  const rawSum = deterministicScore + personaBias + modelAdjustment;
  const finalScore = clamp(rawSum, 0, 100);
  const band = bandForScore(finalScore);

  const trace: DecisionTrace = {
    deterministicScore,
    personaBias,
    modelAdjustment,
    finalScore,
    band,
    evidence: bundle.signals,
    adjustments,
    personaBiasDetail,
    model: input.modelId,
    promptVersion: input.promptVersion,
    cacheHit: input.cacheHit,
    computedAt: new Date().toISOString(),
    // "ok" means the displayed arithmetic is exact — no clamping was needed.
    arithmeticOk: rawSum === finalScore,
  };

  return {
    ...model,
    messageId: message.id,
    schemaVersion: 1,
    priorityBand: band,
    priorityScore: finalScore,
    trace,
    escalatedToPro: input.engine === "deepseek" && input.modelId.includes("pro"),
    // A model whose stated adjustment disagrees with its own itemized reasons is
    // genuinely inconsistent; the itemization wins and we record the conflict.
    isInconsistent: mismatched || itemizedSum !== modelAdjustment,
    engine: input.engine,
    promptVersion: input.promptVersion,
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
    costUsd: input.costUsd ?? 0,
    latencyMs: input.latencyMs ?? 0,
    createdAt: new Date().toISOString(),
  };
}

/** The exact string rendered in the Why? panel header. */
export function arithmeticOf(trace: DecisionTrace): string {
  const { deterministicScore: d, personaBias: p, modelAdjustment: m } = trace;
  const parts = [d];
  if (p !== 0) parts.push(p);
  if (m !== 0) parts.push(m);
  return `${parts.join(" + ").replace(/\+ -/g, "\u2212 ")} = ${trace.finalScore}`;
}

/**
 * Trust gate (PLAN.md §4). Suspicious and phishing mail leaves the ranked queue
 * regardless of how important it claims to be.
 */
export function isQuarantined(verdict: TrustVerdict): boolean {
  return verdict === "suspicious" || verdict === "phishing";
}

/** Noise gate — collapses into the digest rather than the ranked queue. */
export function isDigestOnly(decision: Decision): boolean {
  return (
    decision.noise.isNoise ||
    (decision.trust.verdict === "noise" && decision.priorityScore < 40)
  );
}
