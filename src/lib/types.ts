/**
 * Core domain types for Andro Email.
 *
 * The shape here mirrors the Decision Contract in PLAN.md §4. The important
 * structural rule: the *model* never produces `deterministicScore`, `personaBias`,
 * `finalScore` or `band`. Those are computed server-side in `reconcile.ts`.
 * See `ModelDecision` (model-owned) vs `DecisionTrace` (server-owned).
 */

export type PriorityBand = "P0" | "P1" | "P2" | "P3";

export const PRIORITY_BANDS: PriorityBand[] = ["P0", "P1", "P2", "P3"];

export type TrustVerdict =
  | "legitimate"
  | "marketing"
  | "noise"
  | "suspicious"
  | "phishing";

export type NoiseCategory =
  | "newsletter"
  | "receipt"
  | "notification"
  | "social"
  | "promo";

/** Where a piece of evidence came from. Lets the UI separate fact from inference. */
export type SignalSource =
  | "headers"
  | "text-rules"
  | "thread-history"
  | "contacts"
  | "store"
  | "model";

export type TraceEvidence = {
  /** Stable machine id, e.g. "directRecipient". */
  signal: string;
  /** Human-readable line rendered verbatim in the Why? panel. */
  label: string;
  /** Signed contribution to the deterministic score. */
  weight: number;
  source: SignalSource;
  /** Optional extracted value, e.g. the parsed deadline. */
  value?: string;
};

export type TraceAdjustment = {
  delta: number;
  reason: string;
};

export type PersonaBiasDetail = {
  factor: string;
  delta: number;
  reason: string;
};

/**
 * Server-owned, persisted, append-only. Every point of `finalScore` is
 * attributable to an entry in `evidence`, `personaBiasDetail` or `adjustments`.
 */
export type DecisionTrace = {
  deterministicScore: number;
  personaBias: number;
  modelAdjustment: number;
  finalScore: number;
  band: PriorityBand;
  evidence: TraceEvidence[];
  adjustments: TraceAdjustment[];
  personaBiasDetail: PersonaBiasDetail[];
  model: string;
  promptVersion: string;
  cacheHit: boolean;
  computedAt: string;
  /** Result of the arithmetic assertion. False ⇒ model adjustment was discarded. */
  arithmeticOk: boolean;
};

/** The subset of a decision the model is allowed to author. */
export type ModelDecision = {
  persona: {
    primary: string;
    secondary: string[];
    confidence: number;
    suggestNewPersona: { name: string; reason: string } | null;
  };
  priority: {
    /** Clamped again server-side, never trusted. */
    modelAdjustment: number;
    adjustments: TraceAdjustment[];
  };
  deadline: string | null;
  requiresReply: boolean;
  requiresAction: boolean;
  intelligence: {
    tldr: string;
    asks: Ask[];
    keyFacts: KeyFact[];
    sentiment: string;
    readingTimeSeconds: number;
    entities: Entities;
  };
  trust: {
    verdict: TrustVerdict;
    isSpam: boolean;
    isPhishing: boolean;
    signals: string[];
    riskScore: number;
    warnings: string[];
  };
  noise: {
    isNoise: boolean;
    category: NoiseCategory | null;
    summaryLine: string | null;
  };
  confidence: {
    overall: number;
    needsHumanReview: boolean;
  };
};

export type Ask = {
  text: string;
  owner: "me" | "them" | "unknown";
  due: string | null;
};

export type KeyFact = {
  label: string;
  value: string;
};

export type Entities = {
  people: string[];
  orgs: string[];
  dates: string[];
  money: string[];
  links: string[];
};

/** A fully reconciled, persisted decision. */
export type Decision = ModelDecision & {
  messageId: string;
  schemaVersion: number;
  priorityBand: PriorityBand;
  priorityScore: number;
  trace: DecisionTrace;
  escalatedToPro: boolean;
  isInconsistent: boolean;
  engine: "deepseek" | "heuristic";
  promptVersion: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
};

export type Persona = {
  id: string;
  name: string;
  /** lucide-react icon name. */
  icon: string;
  description: string;
  senderPatterns: string[];
  keywords: string[];
  priorityWeights: {
    senderRelationship: number;
    deadline: number;
    money: number;
    replyNeeded: number;
  };
  autoActions: {
    archiveNoise: boolean;
    labelInGmail: boolean;
    neverAutoArchive: boolean;
  };
  isSystem: boolean;
};

export type Address = {
  name?: string;
  email: string;
};

/** Normalized, sanitized mail as stored and shown to the model. */
export type Message = {
  id: string;
  gmailMessageId: string;
  gmailThreadId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  /** Sanitized plain text. Never raw HTML. */
  cleanBody: string;
  snippet: string;
  receivedAt: string;
  labelIds: string[];
  headers: Record<string, string>;
  hasAttachments: boolean;
  attachmentNames: string[];
  isFromMe: boolean;
  contentHash: string;
  /** True when the owner authored an earlier message in this thread. */
  priorUserReplied: boolean;
};

export type SignalBundle = {
  messageId: string;
  signals: TraceEvidence[];
  baseScore: number;
  computedAt: string;
};

/** Raw mail as delivered by a source adapter, before normalization. */
export type RawMessageLike = {
  gmailMessageId: string;
  gmailThreadId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  body: string;
  receivedAt: string;
  labelIds: string[];
  headers: Record<string, string>;
  hasAttachments: boolean;
  attachmentNames: string[];
  isFromMe: boolean;
};

/** A mail joined with its decision and thread context, as the UI consumes it. */
export type TriagedMail = {
  message: Message;
  decision: Decision | null;
  threadCount: number;
};

export type DailyDigest = {
  date: string;
  totalNoise: number;
  totalActionable: number;
  rolledUp: { messageId: string; subject: string; from: string; line: string }[];
  summary: string;
};

export const BAND_RANGES: Record<PriorityBand, { min: number; max: number }> = {
  P0: { min: 90, max: 100 },
  P1: { min: 70, max: 89 },
  P2: { min: 40, max: 69 },
  P3: { min: 0, max: 39 },
};

export const BAND_LABELS: Record<PriorityBand, string> = {
  P0: "Act now",
  P1: "Today",
  P2: "This week",
  P3: "Whenever",
};

export function bandForScore(score: number): PriorityBand {
  if (score >= 90) return "P0";
  if (score >= 70) return "P1";
  if (score >= 40) return "P2";
  return "P3";
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
