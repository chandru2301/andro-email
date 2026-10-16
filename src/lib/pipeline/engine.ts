import {
  DEEPSEEK_MODEL_FLASH,
  DEEPSEEK_MODEL_PRO,
  ESCALATION_CONFIDENCE_FLOOR,
  ESCALATION_RISK_FLOOR,
  PROMPT_VERSION,
  hasDeepSeekKey,
} from "../config";
import { PERSONAS } from "../personas";
import type { Decision, Message, ModelDecision, SignalBundle } from "../types";
import { deepseekDecide } from "./engines/deepseek";
import { HEURISTIC_ENGINE_LABEL, heuristicDecide } from "./engines/heuristic";
import { reconcile } from "./reconcile";

/**
 * Engine routing (PLAN.md §5.2).
 *
 * Two tiers, plus a floor:
 *   flash  — the bulk of mail
 *   pro    — escalated when being wrong is expensive
 *   rules  — the floor, used when there is no key or the API fails
 *
 * The heuristic decision is always computed. That costs microseconds, and it
 * means degradation is a `reconcile()` call away rather than an error path.
 */

export type EngineMode = "deepseek" | "heuristic";

export type EngineStatus = {
  mode: EngineMode;
  reason: string;
  flashModel: string;
  proModel: string;
};

export function getEngineStatus(): EngineStatus {
  return hasDeepSeekKey()
    ? {
        mode: "deepseek",
        reason: "DEEPSEEK_API_KEY is configured; decisions come from the API.",
        flashModel: DEEPSEEK_MODEL_FLASH,
        proModel: DEEPSEEK_MODEL_PRO,
      }
    : {
        mode: "heuristic",
        reason:
          "No DEEPSEEK_API_KEY set. Running the deterministic rules engine — every decision is explainable but no model judgement is applied.",
        flashModel: DEEPSEEK_MODEL_FLASH,
        proModel: DEEPSEEK_MODEL_PRO,
      };
}

/** The persona rubric is the classifier's instruction sheet (PLAN.md §6.1). */
export function buildPersonaRubric(): string {
  return PERSONAS.map(
    (p) =>
      `- ${p.id} ("${p.name}"): ${p.description}${
        p.senderPatterns.length
          ? ` Typical senders: ${p.senderPatterns.join(", ")}.`
          : ""
      }`,
  ).join("\n");
}

/**
 * Should this decision go to the stronger model? All of these are "the cheap
 * model might be confidently wrong" conditions (PLAN.md §5.2).
 */
function needsEscalation(decision: ModelDecision, bundle: SignalBundle): string | null {
  if (decision.trust.riskScore > ESCALATION_RISK_FLOOR) {
    return `Phishing risk score ${decision.trust.riskScore} exceeds ${ESCALATION_RISK_FLOOR}`;
  }
  if (decision.confidence.overall < ESCALATION_CONFIDENCE_FLOOR) {
    return `Model confidence ${decision.confidence.overall.toFixed(2)} below ${ESCALATION_CONFIDENCE_FLOOR}`;
  }
  if (decision.persona.confidence < ESCALATION_CONFIDENCE_FLOOR) {
    return `Persona confidence ${decision.persona.confidence.toFixed(2)} below ${ESCALATION_CONFIDENCE_FLOOR}`;
  }
  if (decision.confidence.needsHumanReview) {
    return "Model flagged the decision as needing human review";
  }
  if (decision.persona.suggestNewPersona) {
    return `Model proposed a new persona: ${decision.persona.suggestNewPersona.name}`;
  }
  const moneyOrLegal = bundle.signals.some(
    (s) =>
      s.signal === "moneyLanguage" ||
      s.signal === "contractLanguage" ||
      s.signal === "authFail",
  );
  if (moneyOrLegal && decision.priority.adjustments.length > 0) {
    return "Money, contract or authentication signals make an error expensive";
  }
  return null;
}

export type DecideResult = {
  decision: Decision;
  escalationReason: string | null;
  fallbackReason: string | null;
};

export async function decide(args: {
  message: Message;
  bundle: SignalBundle;
  threadDigest: string;
  knownDomains: string[];
  ownerEmail: string;
  /** Force the rules path even when a key is present (used by the eval harness). */
  forceHeuristic?: boolean;
}): Promise<DecideResult> {
  const { message, bundle, threadDigest, knownDomains } = args;

  const heuristic = heuristicDecide({
    message,
    bundle,
    knownDomains,
    ownerEmail: args.ownerEmail,
  });

  const apiKey = args.forceHeuristic
    ? undefined
    : process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    return {
      decision: reconcile({
        message,
        bundle,
        model: heuristic,
        engine: "heuristic",
        modelId: HEURISTIC_ENGINE_LABEL,
        promptVersion: PROMPT_VERSION,
        cacheHit: false,
      }),
      escalationReason: null,
      fallbackReason: null,
    };
  }

  try {
    const rubric = buildPersonaRubric();

    const flash = await deepseekDecide({
      message,
      bundle,
      threadDigest,
      personaRubric: rubric,
      modelId: DEEPSEEK_MODEL_FLASH,
      apiKey,
    });

    let chosen = flash;
    let escalationReason: string | null = null;

    const reason = needsEscalation(flash.decision, bundle);
    if (reason) {
      escalationReason = reason;
      try {
        chosen = await deepseekDecide({
          message,
          bundle,
          threadDigest,
          personaRubric: rubric,
          modelId: DEEPSEEK_MODEL_PRO,
          apiKey,
        });
      } catch {
        // Pro failed; the flash decision is still valid, so keep it.
        chosen = flash;
        escalationReason = `${reason} (escalation attempt failed; using flash result)`;
      }
    }

    return {
      decision: reconcile({
        message,
        bundle,
        model: chosen.decision,
        engine: "deepseek",
        modelId: chosen.modelId,
        promptVersion: PROMPT_VERSION,
        cacheHit: chosen.cacheHit,
        tokensIn: chosen.tokensIn,
        tokensOut: chosen.tokensOut,
        costUsd: chosen.costUsd,
        latencyMs: chosen.latencyMs,
      }),
      escalationReason,
      fallbackReason: null,
    };
  } catch (error) {
    // Circuit-breaker behaviour: degrade, never drop (PLAN.md §2.6).
    const detail = error instanceof Error ? error.message : String(error);
    return {
      decision: reconcile({
        message,
        bundle,
        model: heuristic,
        engine: "heuristic",
        modelId: HEURISTIC_ENGINE_LABEL,
        promptVersion: PROMPT_VERSION,
        cacheHit: false,
      }),
      escalationReason: null,
      fallbackReason: `DeepSeek unavailable, fell back to rules: ${detail}`,
    };
  }
}
