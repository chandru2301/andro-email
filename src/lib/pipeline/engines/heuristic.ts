import { PERSONAS } from "../../personas";
import {
  type Entities,
  type Message,
  type ModelDecision,
  type SignalBundle,
  type TrustVerdict,
} from "../../types";
import { domainOf } from "../../utils";
import { extractLinks, headerValue } from "../normalize";

/**
 * The offline decision engine.
 *
 * This is not a stub. It is the graceful-degradation path required by
 * PLAN.md §2.6: when DeepSeek is unreachable, over budget, or unconfigured, mail
 * still lands in a correctly-sorted, *explainable* inbox. Every decision it
 * produces is labelled `engine: "heuristic"` so the UI never implies AI
 * judgement that did not happen.
 *
 * It is also the baseline the golden set is measured against.
 */

const BRAND_HINTS = [
  "github",
  "google",
  "microsoft",
  "apple",
  "amazon",
  "paypal",
  "stripe",
  "netflix",
  "linkedin",
  "docusign",
  "dropbox",
  "adobe",
  "northwind",
];

const URGENCY =
  /\b(urgent|immediately|asap|act now|within 24 hours|final notice|suspend(?:ed)?|verify your|unusual sign-?in|limited time|expires today)\b/i;
const CREDENTIAL =
  /\b(password|passcode|otp|one-?time code|verify your account|re-?authenticate|sign in to confirm|update your (?:billing|payment)|click here to (?:verify|restore)|bank details|remittance|wire transfer|account number)\b/i;

/** Cheap homoglyph/lookalike check against the domains we know. */
function looksLikeLookalike(domain: string, known: string[]): string | null {
  for (const candidate of known) {
    if (domain === candidate) continue;
    if (domain.length < 4 || candidate.length < 4) continue;
    if (Math.abs(domain.length - candidate.length) > 1) continue;

    let diff = 0;
    for (let i = 0; i < Math.min(domain.length, candidate.length); i++) {
      if (domain[i] !== candidate[i]) diff++;
    }
    // One or two substituted characters in the same shape = suspicious.
    if (diff > 0 && diff <= 2) return candidate;
  }
  return null;
}

/** Consumer mailbox providers — a strong hint of personal rather than work mail. */
const CONSUMER_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
];

function classifyPersona(
  message: Message,
  bundle: SignalBundle,
  knownDomains: string[],
  ownerEmail: string,
): { primary: string; secondary: string[]; confidence: number } {
  const domain = domainOf(message.from.email);
  const haystack = `${message.subject}\n${message.cleanBody}`.toLowerCase();
  const present = new Set(bundle.signals.map((s) => s.signal));

  const isBulk =
    present.has("listUnsubscribe") || present.has("bulkPrecedence");

  // 1. Sender patterns are the strongest signal we have.
  for (const persona of PERSONAS) {
    if (persona.id === "noise") continue;
    const hit = persona.senderPatterns.find((p) =>
      domain.includes(p.toLowerCase()),
    );
    if (hit) {
      return { primary: persona.id, secondary: [], confidence: 0.88 };
    }
  }

  // 2. A payment problem outranks the bulk penalty. These arrive from automated
  //    senders (Stripe, banks) that look exactly like marketing, and misfiling
  //    one as noise is the expensive, invisible error.
  if (present.has("paymentFailure")) {
    return { primary: "finance", secondary: [], confidence: 0.82 };
  }

  // 3. Mail from the owner's own domain is internal by definition.
  const ownerDomain = domainOf(ownerEmail);
  if (ownerDomain && domain === ownerDomain) {
    return { primary: "work-internal", secondary: [], confidence: 0.85 };
  }

  // 4. Bulk mail is noise regardless of topic.
  if (isBulk) {
    return { primary: "noise", secondary: [], confidence: 0.8 };
  }

  // 5. Keyword scoring. Runs *before* the consumer-mailbox rule so that a
  //    colleague writing from a personal address about work still lands in a
  //    work persona.
  const scored = PERSONAS.filter((p) => p.id !== "noise")
    .map((persona) => {
      const score = persona.keywords.reduce(
        (sum, kw) => (haystack.includes(kw.toLowerCase()) ? sum + 1 : sum),
        0,
      );
      return { persona, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const [best, second] = scored;
    return {
      primary: best.persona.id,
      secondary: second ? [second.persona.id] : [],
      confidence: Math.min(0.55 + best.score * 0.1, 0.85),
    };
  }

  // 6. A human writing from a consumer mailbox with no work signal is personal.
  if (CONSUMER_DOMAINS.includes(domain)) {
    return { primary: "personal", secondary: [], confidence: 0.7 };
  }

  // 7. Relationship fallback.
  if (present.has("senderRelationship") || knownDomains.includes(domain)) {
    return { primary: "work-internal", secondary: [], confidence: 0.5 };
  }

  return { primary: "work-internal", secondary: [], confidence: 0.35 };
}

function assessTrust(
  message: Message,
  bundle: SignalBundle,
  knownDomains: string[],
): ModelDecision["trust"] {
  const signals: string[] = [];
  const warnings: string[] = [];
  const present = new Set(bundle.signals.map((s) => s.signal));
  const domain = domainOf(message.from.email);
  const body = message.cleanBody;
  const authResults = headerValue(message.headers, "Authentication-Results") ?? "";
  const replyTo = headerValue(message.headers, "Reply-To") ?? "";
  const fromName = message.from.name ?? "";

  let risk = 0;

  const authFail = present.has("authFail");
  if (authFail) {
    risk += 35;
    signals.push(`Authentication failed: ${authResults.slice(0, 120)}`);
    warnings.push("SPF/DKIM/DMARC did not pass for this sender");
  } else if (authResults) {
    signals.push(authResults.slice(0, 120));
  }

  // Display-name impersonation.
  const nameBrand = BRAND_HINTS.find((b) =>
    fromName.toLowerCase().includes(b),
  );
  if (nameBrand && !domain.includes(nameBrand)) {
    risk += 30;
    warnings.push(
      `Display name mentions "${nameBrand}" but the sending domain is ${domain}`,
    );
  }

  const lookalike = looksLikeLookalike(domain, knownDomains);
  // Skip this entirely for domains we already correspond with regularly:
  // `github.com` and `gitlab.com` differ by two characters and would otherwise
  // flag every CI notification as impersonation.
  if (lookalike && !knownDomains.includes(domain)) {
    risk += 30;
    warnings.push(
      `${domain} closely resembles the known domain ${lookalike}`,
    );
  }

  // Reply-To divergence.
  if (replyTo && domainOf(replyTo) && domainOf(replyTo) !== domain) {
    risk += 15;
    warnings.push(
      `Replies would go to a different domain (${domainOf(replyTo)})`,
    );
  }

  const urgent = URGENCY.test(body) || URGENCY.test(message.subject);
  const credential = CREDENTIAL.test(body);
  if (urgent && credential) {
    risk += 35;
    warnings.push(
      "Combines urgency with a request to verify credentials or change payment details",
    );
  } else if (credential) {
    risk += 12;
  }

  // Link text vs href mismatch is approximated by counting distinct link domains.
  const links = extractLinks(body);
  const linkDomains = new Set(links.map((l) => domainOf(l.replace(/^https?:\/\//, ""))));
  if (links.length > 0) {
    signals.push(`${links.length} link(s) to ${linkDomains.size} domain(s)`);
  }

  risk = Math.min(100, risk);

  let verdict: TrustVerdict = "legitimate";
  if (risk >= 55) verdict = "phishing";
  else if (risk >= 30) verdict = "suspicious";
  else if (present.has("listUnsubscribe") || present.has("bulkPrecedence"))
    verdict = "marketing";

  if (verdict === "legitimate" && present.has("autoSubmitted") && present.has("noReplySender")) {
    verdict = "noise";
  }

  return {
    verdict,
    isSpam: verdict === "noise",
    isPhishing: verdict === "phishing",
    signals,
    riskScore: risk,
    warnings,
  };
}

function extractEntities(body: string, links: string[]): Entities {
  const money =
    body.match(
      /(?:\$|usd|inr|eur|gbp|₹|€|£)\s?\d[\d,]*(?:\.\d{1,2})?/gi,
    ) ?? [];
  const dates =
    body.match(
      /\b\d{4}-\d{2}-\d{2}\b|\b(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b/gi,
    ) ?? [];
  const orgs = Array.from(
    new Set(
      (body.match(/\b[A-Z][A-Za-z&.'-]+(?:\s+[A-Z][A-Za-z&.'-]+){0,2}\s+(?:Ltd|LLC|Inc|Corp|GmbH|Pvt|Limited)\b/g) ?? []),
    ),
  );
  return {
    people: [],
    orgs: orgs.slice(0, 6),
    dates: Array.from(new Set(dates)).slice(0, 6),
    money: Array.from(new Set(money)).slice(0, 6),
    links: links.slice(0, 6),
  };
}

function buildHeuristicAdjustments(
  bundle: SignalBundle,
): { delta: number; reason: string }[] {
  const present = new Set(bundle.signals.map((s) => s.signal));
  const out: { delta: number; reason: string }[] = [];

  if (present.has("unansweredQuestion") && present.has("directRecipient")) {
    out.push({
      delta: 6,
      reason: "Open question addressed directly to you implies a pending reply",
    });
  }
  if (present.has("explicitDeadline")) {
    out.push({
      delta: 6,
      reason: "A deadline is stated, so delay has a cost",
    });
  }
  if (present.has("moneyLanguage") || present.has("contractLanguage")) {
    out.push({
      delta: 3,
      reason: "Payment or contract language raises the cost of an error",
    });
  }
  if (present.has("authFail")) {
    out.push({
      delta: -5,
      reason: "Failed authentication lowers confidence in the sender's intent",
    });
  }

  // Cap is enforced again in reconcile.ts; this keeps the heuristic honest too.
  let running = 0;
  return out.filter((a) => {
    running += a.delta;
    return Math.abs(running) <= 15;
  });
}

export function heuristicDecide(args: {
  message: Message;
  bundle: SignalBundle;
  knownDomains: string[];
  ownerEmail: string;
}): ModelDecision {
  const { message, bundle, knownDomains, ownerEmail } = args;
  const persona = classifyPersona(message, bundle, knownDomains, ownerEmail);
  const trust = assessTrust(message, bundle, knownDomains);
  const links = extractLinks(message.cleanBody);
  const present = new Set(bundle.signals.map((s) => s.signal));

  // A reported payment problem is never noise, however automated it looks.
  const isNoise =
    !present.has("paymentFailure") &&
    (persona.primary === "noise" ||
      trust.verdict === "noise" ||
      present.has("listUnsubscribe"));

  const words = message.cleanBody.split(/\s+/).filter(Boolean).length;
  const readingTimeSeconds = Math.max(5, Math.round((words / 200) * 60));

  const sentences = message.cleanBody
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const tldr =
    sentences.slice(0, 2).join(" ").slice(0, 240) ||
    message.snippet ||
    "(no content)";

  const questionSentence = sentences.find((s) => s.includes("?"));

  const noiseCategory = isNoise
    ? present.has("listUnsubscribe")
      ? "newsletter"
      : present.has("autoSubmitted")
        ? "receipt"
        : "promo"
    : null;

  return {
    persona: {
      primary: persona.primary,
      secondary: persona.secondary,
      confidence: persona.confidence,
      suggestNewPersona: null,
    },
    priority: {
      modelAdjustment: buildHeuristicAdjustments(bundle).reduce(
        (s, a) => s + a.delta,
        0,
      ),
      adjustments: buildHeuristicAdjustments(bundle),
    },
    deadline: present.has("explicitDeadline")
      ? (bundle.signals.find((s) => s.signal === "explicitDeadline")?.value ??
        null)
      : null,
    requiresReply: present.has("unansweredQuestion") && !isNoise,
    requiresAction:
      present.has("unansweredQuestion") ||
      present.has("calendarInvite") ||
      present.has("moneyLanguage"),
    intelligence: {
      tldr,
      asks:
        questionSentence && !isNoise
          ? [
              {
                text: questionSentence.slice(0, 200),
                owner: "me" as const,
                due:
                  bundle.signals.find((s) => s.signal === "explicitDeadline")
                    ?.value ?? null,
              },
            ]
          : [],
      keyFacts: (bundle.signals.find((s) => s.signal === "moneyLanguage")
        ? [
            {
              label: "Amount",
              value:
                bundle.signals.find((s) => s.signal === "moneyLanguage")
                  ?.value ?? "",
            },
          ]
        : []
      ).filter((f) => f.value.length > 0),
      sentiment: trust.riskScore >= 30 ? "concerning" : "neutral",
      readingTimeSeconds,
      entities: extractEntities(message.cleanBody, links),
    },
    trust,
    noise: {
      isNoise,
      category: noiseCategory,
      summaryLine: isNoise
        ? `${message.from.name ?? message.from.email}: ${message.subject}`.slice(
            0,
            160,
          )
        : null,
    },
    confidence: {
      overall: Math.min(persona.confidence, 0.7),
      needsHumanReview: persona.confidence < 0.5,
    },
  };
}

export const HEURISTIC_ENGINE_LABEL = "heuristic-rules";
