/**
 * Runtime configuration.
 *
 * Model names live here and nowhere else. DeepSeek has retired and renamed
 * models before (legacy `deepseek-v4-flash` is now served by V4.1-Flash), so
 * they are configuration, not constants baked into call sites.
 */

export const DEEPSEEK_BASE_URL =
  process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

export const DEEPSEEK_MODEL_FLASH =
  process.env.DEEPSEEK_MODEL_FLASH ?? "deepseek-flash";

export const DEEPSEEK_MODEL_PRO =
  process.env.DEEPSEEK_MODEL_PRO ?? "deepseek-v4-pro";

export const PROMPT_VERSION = "v1";

/**
 * Escalation trigger (PLAN.md §5.2). Flash handles the bulk; Pro is reserved
 * for mail where being wrong is expensive.
 */
export const ESCALATION_CONFIDENCE_FLOOR = 0.75;
export const ESCALATION_RISK_FLOOR = 40;

/** Per-1M-token prices in USD, peak. Off-peak is half of these. */
export const PRICING = {
  [DEEPSEEK_MODEL_FLASH]: {
    inputCacheMiss: 0.3,
    inputCacheHit: 0.006,
    output: 1.2,
  },
  [DEEPSEEK_MODEL_PRO]: {
    inputCacheMiss: 1.32,
    inputCacheHit: 0.044,
    output: 3.96,
  },
} as const;

export type ModelId = keyof typeof PRICING;

export function isPeakHour(at: Date = new Date()): boolean {
  // Peak: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri (PLAN.md §5.4 / REVIEW.md #3).
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function estimateCostUsd(args: {
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  cacheHit: boolean;
  at?: Date;
}): number {
  const pricing =
    PRICING[args.modelId as ModelId] ?? PRICING[DEEPSEEK_MODEL_FLASH];
  const multiplier = isPeakHour(args.at) ? 1 : 0.5;
  const inputRate = args.cacheHit
    ? pricing.inputCacheHit
    : pricing.inputCacheMiss;
  const cost =
    (args.tokensIn / 1_000_000) * inputRate +
    (args.tokensOut / 1_000_000) * pricing.output;
  return Number((cost * multiplier).toFixed(6));
}

/** Whether a live API key is configured. Drives engine selection. */
export function hasDeepSeekKey(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

export const DEFAULT_OWNER_EMAIL =
  process.env.ANDRO_OWNER_EMAIL ?? "owner@example.com";

/** Hard ceiling per request, enforced before dispatch (PLAN.md §5.4). */
export const MAX_OUTPUT_TOKENS = 1600;
