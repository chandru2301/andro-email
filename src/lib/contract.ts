import { z } from "zod";

/**
 * The Decision Contract (PLAN.md §4).
 *
 * `modelDecisionSchema` validates what the *model* is allowed to author. Note
 * what is absent: `deterministicScore`, `personaBias`, `finalScore`, `band`.
 * Those are computed server-side in `reconcile.ts`, so a model can never inflate
 * its own influence or invent a priority band.
 */

export const PERSONA_IDS = [
  "work-client",
  "work-internal",
  "founder",
  "finance",
  "oss",
  "recruiter",
  "personal",
  "noise",
] as const;

export const TRUST_VERDICTS = [
  "legitimate",
  "marketing",
  "noise",
  "suspicious",
  "phishing",
] as const;

export const NOISE_CATEGORIES = [
  "newsletter",
  "receipt",
  "notification",
  "social",
  "promo",
] as const;

const askSchema = z.object({
  text: z.string(),
  owner: z.enum(["me", "them", "unknown"]),
  due: z.string().nullable(),
});

const keyFactSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const entitiesSchema = z.object({
  people: z.array(z.string()),
  orgs: z.array(z.string()),
  dates: z.array(z.string()),
  money: z.array(z.string()),
  links: z.array(z.string()),
});

const adjustmentSchema = z.object({
  delta: z.number(),
  reason: z.string(),
});

export const modelDecisionSchema = z.object({
  persona: z.object({
    primary: z.enum(PERSONA_IDS),
    secondary: z.array(z.enum(PERSONA_IDS)),
    confidence: z.number().min(0).max(1),
    suggestNewPersona: z
      .object({ name: z.string(), reason: z.string() })
      .nullable(),
  }),
  priority: z.object({
    /** Advisory only. Clamped again in reconcile.ts — never trusted. */
    modelAdjustment: z.number(),
    adjustments: z.array(adjustmentSchema),
  }),
  deadline: z.string().nullable(),
  requiresReply: z.boolean(),
  requiresAction: z.boolean(),
  intelligence: z.object({
    tldr: z.string(),
    asks: z.array(askSchema),
    keyFacts: z.array(keyFactSchema),
    sentiment: z.string(),
    readingTimeSeconds: z.number(),
    entities: entitiesSchema,
  }),
  trust: z.object({
    verdict: z.enum(TRUST_VERDICTS),
    isSpam: z.boolean(),
    isPhishing: z.boolean(),
    signals: z.array(z.string()),
    riskScore: z.number().min(0).max(100),
    warnings: z.array(z.string()),
  }),
  noise: z.object({
    isNoise: z.boolean(),
    category: z.enum(NOISE_CATEGORIES).nullable(),
    summaryLine: z.string().nullable(),
  }),
  confidence: z.object({
    overall: z.number().min(0).max(1),
    needsHumanReview: z.boolean(),
  }),
});

export type ParsedModelDecision = z.infer<typeof modelDecisionSchema>;

/** The JSON example embedded in the DeepSeek prompt. */
export const CONTRACT_EXAMPLE = `{
  "persona": {
    "primary": "work-client",
    "secondary": ["finance"],
    "confidence": 0.92,
    "suggestNewPersona": null
  },
  "priority": {
    "modelAdjustment": 11,
    "adjustments": [
      { "delta": 7, "reason": "Question is unanswered and time-sensitive beyond the detected deadline" },
      { "delta": 4, "reason": "Contract language implies a financial commitment" }
    ]
  },
  "deadline": "2026-09-24T17:00:00Z",
  "requiresReply": true,
  "requiresAction": true,
  "intelligence": {
    "tldr": "Client approves scope but wants the redline signed before Thursday standup.",
    "asks": [{ "text": "Sign the redlined SOW", "owner": "me", "due": "2026-09-24" }],
    "keyFacts": [{ "label": "Amount", "value": "$48,000" }],
    "sentiment": "neutral-positive",
    "readingTimeSeconds": 22,
    "entities": {
      "people": ["Dana Reyes"], "orgs": ["Northwind Ltd"],
      "dates": ["2026-09-24"], "money": ["$48,000"], "links": ["https://example.com"]
    }
  },
  "trust": {
    "verdict": "legitimate",
    "isSpam": false,
    "isPhishing": false,
    "signals": ["SPF pass, DKIM pass, DMARC pass"],
    "riskScore": 4,
    "warnings": []
  },
  "noise": { "isNoise": false, "category": null, "summaryLine": null },
  "confidence": { "overall": 0.94, "needsHumanReview": false }
}`;
