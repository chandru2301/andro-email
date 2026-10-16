import type { Message, SignalBundle, TraceEvidence } from "../types";
import { clamp } from "../types";
import { domainOf } from "../utils";
import { headerValue } from "./normalize";

/**
 * The Pre-Scorer (PLAN.md §7.1).
 *
 * This is the "deterministic before probabilistic" principle made concrete.
 * Its output is a `SignalBundle`: numbered, attributable evidence with signed
 * weights — never prose. The model receives this as *evidence to weigh*, not as
 * something it has to rediscover from the text. It is also the main cost lever:
 * anything the rules can decide outright never reaches the API.
 */

/**
 * Calibration note.
 *
 * The weights below are tuned so that the *sum* lands in the right band without
 * a normalisation curve — the arithmetic shown in the Why? panel is the real
 * arithmetic. Targets:
 *
 *   full P0 client mail (direct + thread + known + deadline + ask + money)  ~99
 *   colleague asking for a review (direct + known + ask)                   ~54
 *   newsletter (bulk + unsub + no-reply)                                    ~0
 *   automated receipt (direct + auto-submitted + no-reply)                  ~0
 *
 * Ordinary direct mail therefore lands mid-P2, and the model's ±15 is what
 * lifts a genuinely actionable internal ask into P1. That split is deliberate:
 * the rules establish *legitimacy and relationship*, the model adjudicates
 * *urgency of the ask*.
 */

export type PrescorerContext = {
  ownerEmail: string;
  /** Domains the owner has a real relationship with. */
  knownDomains: string[];
  /** How many messages exist in the thread (including this one). */
  threadCount: number;
};

const WEEKDAY =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i;
const MONTH =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const RELATIVE =
  /\b(today|tomorrow|tonight|end of day|end of week|eod|cob|asap|next week|this week|by end of)\b/i;
const DEADLINE_CUE =
  /\b(by|before|due|deadline|no later than|until|expires?|closes?)\b/i;

const MONEY =
  /(?:\$|usd|inr|eur|gbp|₹|€|£)\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:usd|inr|eur|gbp|dollars?|rupees?)\b/i;

const CONTRACT =
  /\b(sow|statement of work|contract|agreement|redline|msa|nda|addendum|amendment|terms|signature|sign[- ]?off|countersign)\b/i;

/**
 * A failed payment is the archetypal "quiet, expensive" message (REVIEW.md #8).
 * It arrives from an automated bulk sender, so naive rules file it as noise —
 * exactly when it matters most. This signal exists to outrank the bulk penalty.
 */
const PAYMENT_FAILURE =
  /\b(payment (?:could not be processed|failed|declined|on hold)|could not be processed|failed payment|card (?:was )?declined|insufficient funds|past due|unable to process (?:your )?payment|payment method (?:was )?declined|we couldn'?t process)\b/i;

const REQUEST_VERB =
  /\b(can you|could you|would you|please|need you to|let me know|confirm|approve|review|sign|send|share|advise|your thoughts|any update|following up)\b/i;

const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|bounce|alerts?|support|hello|news|updates?|noreply)$/i;

function findDeadlineValue(body: string): string | null {
  const iso = body.match(ISO_DATE);
  if (iso) return iso[0];

  const weekdayMatch = body.match(
    /\b(?:by|before|due|on|no later than|until)\s+(.{0,24}?)\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i,
  );
  if (weekdayMatch) {
    return `${weekdayMatch[1]}${weekdayMatch[2]}`.trim();
  }

  const weekday = body.match(WEEKDAY);
  if (weekday) return weekday[0];

  const month = body.match(MONTH);
  if (month) return month[0];

  const relative = body.match(RELATIVE);
  if (relative) return relative[0];

  return null;
}

/** Does the *action region* of the mail contain a question? */
function hasLingeringQuestion(body: string): boolean {
  const tail = body.slice(Math.floor(body.length * 0.55));
  return tail.includes("?") || (REQUEST_VERB.test(tail) && tail.length > 0);
}

function isUnread(message: Message): boolean {
  return message.labelIds.includes("UNREAD");
}

/**
 * Extract every deterministic signal for a message.
 *
 * Every entry returned here is rendered verbatim in the UI's Why? panel, so the
 * `label` is user-facing copy, not a debug string.
 */
export function prescore(
  message: Message,
  ctx: PrescorerContext,
): SignalBundle {
  const signals: TraceEvidence[] = [];
  const headers = message.headers;
  const body = message.cleanBody;
  /**
   * Text rules run against subject + body. Subjects carry a lot of the signal
   * ("Payment failed", "due October 3") and matching only the body missed them.
   */
  const haystack = `${message.subject}\n${body}`;
  const fromDomain = domainOf(message.from.email);
  const localPart = message.from.email.split("@")[0] ?? "";

  const hasUnsub = Boolean(headerValue(headers, "List-Unsubscribe"));
  const precedence = headerValue(headers, "Precedence") ?? "";
  const autoSubmitted = headerValue(headers, "Auto-Submitted") ?? "";
  const authResults = headerValue(headers, "Authentication-Results") ?? "";

  const isBulk =
    hasUnsub ||
    /bulk|junk|list/i.test(precedence) ||
    autoSubmitted.length > 0;

  /**
   * A transactional alert about money is not marketing, even though it is sent
   * by the same machinery (no-reply address, bulk headers, auto-submitted).
   *
   * The bulk penalties are a *relationship* judgement and they total -73, which
   * is more than enough to bury a failed payment at the bottom of the queue.
   * When a payment problem is detected the message is exempted from them, so the
   * only thing left to score is the fact that money did not move.
   */
  const paymentFailure = haystack.match(PAYMENT_FAILURE);
  const treatAsBulk = isBulk && !paymentFailure;

  // --- positive signals -----------------------------------------------------

  const addressedDirectly =
    message.to.some(
      (a) => a.email.toLowerCase() === ctx.ownerEmail.toLowerCase(),
    ) && !treatAsBulk;

  if (addressedDirectly) {
    signals.push({
      signal: "directRecipient",
      label: "You were directly addressed",
      weight: 20,
      source: "headers",
      value: message.to.map((a) => a.email).join(", "),
    });
  } else if (message.cc.some((a) => a.email.toLowerCase() === ctx.ownerEmail.toLowerCase())) {
    signals.push({
      signal: "ccRecipient",
      label: "You were only copied",
      weight: 6,
      source: "headers",
    });
  }

  if (paymentFailure) {
    signals.push({
      signal: "paymentFailure",
      label: `Payment problem reported (${paymentFailure[0].trim()})`,
      weight: 34,
      source: "text-rules",
      value: paymentFailure[0].trim(),
    });
  }

  if (message.priorUserReplied) {
    signals.push({
      signal: "threadParticipation",
      label: "You previously replied in this thread",
      weight: 18,
      source: "thread-history",
      value: `${ctx.threadCount} messages`,
    });
  }

  const knownDomain =
    ctx.knownDomains.includes(fromDomain) || message.priorUserReplied;

  if (knownDomain && !message.isFromMe) {
    signals.push({
      signal: "senderRelationship",
      label: "Known contact or client domain",
      weight: 16,
      source: "contacts",
      value: fromDomain,
    });
  }

  const deadlineValue = findDeadlineValue(haystack);
  const hasDeadlineCue = DEADLINE_CUE.test(haystack);
  if (deadlineValue && (hasDeadlineCue || WEEKDAY.test(body) || ISO_DATE.test(body))) {
    signals.push({
      signal: "explicitDeadline",
      label: `Deadline detected: ${deadlineValue}`,
      weight: 16,
      source: "text-rules",
      value: deadlineValue,
    });
  }

  if (!message.isFromMe && hasLingeringQuestion(body)) {
    signals.push({
      signal: "unansweredQuestion",
      label: "Contains a question or request aimed at you",
      weight: 18,
      source: "text-rules",
    });
  }

  const moneyMatch = haystack.match(MONEY);
  if (moneyMatch) {
    signals.push({
      signal: "moneyLanguage",
      label: `Money amount mentioned (${moneyMatch[0].trim()})`,
      weight: 6,
      source: "text-rules",
      value: moneyMatch[0].trim(),
    });
  }

  if (CONTRACT.test(haystack)) {
    signals.push({
      signal: "contractLanguage",
      label: "Contract or agreement language",
      weight: 5,
      source: "text-rules",
    });
  }

  const contentType = headerValue(headers, "Content-Type") ?? "";
  const hasCalendar =
    /text\/calendar/i.test(contentType) ||
    message.attachmentNames.some((n) => n.toLowerCase().endsWith(".ics")) ||
    /\b(invitation|invite|rsvp|calendar)\b/i.test(message.subject);

  if (hasCalendar) {
    signals.push({
      signal: "calendarInvite",
      label: "Calendar invitation or RSVP",
      weight: 12,
      source: "headers",
    });
  }

  // --- negative signals -----------------------------------------------------
  // All suppressed for a reported payment problem — see `treatAsBulk` above.

  if (hasUnsub && treatAsBulk) {
    signals.push({
      signal: "listUnsubscribe",
      label: "Bulk mail header present (List-Unsubscribe)",
      weight: -22,
      source: "headers",
    });
  }

  if (/bulk|junk|list/i.test(precedence) && treatAsBulk) {
    signals.push({
      signal: "bulkPrecedence",
      label: `Marked as bulk mail (Precedence: ${precedence.trim()})`,
      weight: -25,
      source: "headers",
    });
  }

  if (autoSubmitted.length > 0 && treatAsBulk) {
    signals.push({
      signal: "autoSubmitted",
      label: "Automatically generated message",
      weight: -16,
      source: "headers",
    });
  }

  if (AUTOMATED_LOCAL.test(localPart) && treatAsBulk) {
    signals.push({
      signal: "noReplySender",
      label: `Sent from an unmonitored address (${localPart}@)`,
      weight: -16,
      source: "headers",
      value: message.from.email,
    });
  }

  const authFail = /\b(dmarc|spf|dkim)\s*=\s*(fail|softfail|permerror)/i.exec(
    authResults,
  );
  if (authFail) {
    signals.push({
      signal: "authFail",
      label: `Email authentication failed (${authFail[1].toLowerCase()}=${authFail[2]})`,
      weight: -30,
      source: "headers",
      value: authResults.slice(0, 160),
    });
  }

  if (message.isFromMe) {
    signals.push({
      signal: "sentByOwner",
      label: "Sent by you",
      weight: -60,
      source: "headers",
    });
  } else if (!isUnread(message)) {
    signals.push({
      signal: "alreadyRead",
      label: "Already read",
      weight: -10,
      source: "store",
    });
  }

  const baseScore = clamp(
    signals.reduce((sum, s) => sum + s.weight, 0),
    0,
    100,
  );

  return {
    messageId: message.id,
    signals,
    baseScore,
    computedAt: new Date().toISOString(),
  };
}

/** Which persona weight factors are "live" for this bundle. */
export function activeFactors(bundle: SignalBundle): {
  senderRelationship: boolean;
  deadline: boolean;
  money: boolean;
  replyNeeded: boolean;
} {
  const present = new Set(bundle.signals.map((s) => s.signal));
  return {
    senderRelationship:
      present.has("senderRelationship") ||
      present.has("directRecipient") ||
      present.has("threadParticipation"),
    deadline: present.has("explicitDeadline"),
    money: present.has("moneyLanguage") || present.has("contractLanguage"),
    replyNeeded: present.has("unansweredQuestion"),
  };
}
