# Andro Email — Persona-Aware, Priority-Ranked AI Mail Triage

**Status:** M0–M4 implemented — see `README.md` for the runnable app and the
current known limitations. This document remains the design of record.
**Stack:** Next.js (App Router) · shadcn/ui · Tailwind v4 · DeepSeek · Gmail API
**Theme:** Dark — black canvas, white primary, monochrome priority ramp
**Core idea:** The inbox stops showing you *mail*. It shows you *decisions* — who this is for (persona), how much it matters (priority), and what it actually says (intelligence brief). DeepSeek is the arbiter of all three.

> **Implementation notes (what changed on contact with the build):**
> - §5.1 **vision is gone** — the Flash vision endpoint was retired, so attachment
>   analysis is cut (REVIEW.md #1). §16 Q1 is resolved: no.
> - **SQLite via `node:sqlite` replaced Postgres/Prisma**, and the pipeline runs
>   in-process instead of on BullMQ. Same stages, no external services.
> - **§7.3 gained a persona-bias cap of ±8.** Uncapped, a persona weighting every
>   live factor contributed 15 points and drove almost everything to P0.
> - **Text rules now run against subject + body.** Matching only the body missed
>   "payment could not be processed" and similar subject-line signals.
> - **`paymentFailure` exempts a message from the bulk penalties.** Those total
>   −73, which buried failed-payment alerts from automated senders as noise —
>   the quiet, expensive error REVIEW.md #8 warns about.
> - **§7.3's "±15 cap" is enforced in `reconcile.ts`**, and `/api/health`
>   re-asserts the arithmetic invariant for every persisted decision.
> - **§5.2's two-tier skip is NOT implemented.** Every inbound message is sent to
>   DeepSeek when a key is set; the pre-scorer feeds the model evidence rather
>   than gating the call. Likewise §5.3 batching is not implemented (one call per
>   message) and §5.4 has no token ceiling. Measured cost is ~$0.79 per 1,000
>   messages with a warm prompt cache, so this is affordable but the "cost lever"
>   claim above is aspirational, not built.

---

## 1. Problem Statement

A raw inbox is an unfiltered stream: newsletters, receipts, phishing, CC-noise, and — buried in it — the four messages that actually need a human. Reading is the bottleneck; triage is the real work.

Andro Email replaces "list of senders and subjects" with a **triaged queue**:

| Today | Andro Email |
| --- | --- |
| You read every subject line | You see `P0 · Client · "Contract redline needs your sign-off by Thu"` |
| Spam and marketing take visual space | Noise is quarantined and collapsed into one daily digest line |
| You open a mail to learn what it wants | The brief states the ask, the deadline, and the amount up front |
| One inbox for every role you play | Persona lanes: Work, Founder, Personal, Finance, OSS, Recruiter |
| You decide if it's phishing | DeepSeek flags it, and the link is never rendered clickable |

---

## 2. Design Principles

1. **Decision, not summary.** Every AI call ends in a structured verdict the app can *act* on (route, rank, quarantine), not prose the user must re-interpret.
2. **DeepSeek is the decision maker, not a decoration.** Persona assignment, priority band, spam/phishing verdict, and action extraction are all outputs of one contractual JSON decision per mail.
3. **Deterministic before probabilistic.** Cheap, provable signals (DMARC, thread membership, list headers, deadline regex) run first and become *evidence* handed to the model — not something the model has to guess. This is also the main cost lever.
4. **Untrusted input by default.** Email bodies are hostile data. They are sanitized, delimited, and never treated as instructions (see §9 prompt-injection defense).
5. **Monochrome is the interface.** Black and white carry the design. Color is reserved — used only where it means something (urgency, danger).
6. **Fail loud, degrade soft.** If DeepSeek is down or over budget, mail still lands in a heuristic-sorted inbox, clearly marked as un-analyzed. Never silently drop mail.
7. **Every score is attributable.** No decision ships without a trace that reconciles arithmetically and separates deterministic fact from model inference. Explainability is not a debug view bolted on later — it's a required field of the contract (§7.3).

---

## 3. System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                            Next.js App                               │
│                                                                      │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────────────────┐  │
│  │ Persona    │  │ Triage Queue │  │ Intelligence Brief           │  │
│  │ Rail       │  │ (priority)   │  │ (per-mail, streamed)         │  │
│  └────────────┘  └──────────────┘  └──────────────────────────────┘  │
│         shadcn/ui · Tailwind v4 · dark monochrome tokens             │
└───────────────┬──────────────────────────────────────────────────────┘
                │ Route Handlers / Server Actions
┌───────────────▼──────────────────────────────────────────────────────┐
│                          API / Service Layer                          │
│  /api/sync   /api/mails   /api/triage/:id   /api/personas             │
│  /api/digest   /api/rules   /api/stream/brief   /api/feedback         │
└───┬───────────────┬──────────────────┬───────────────────┬───────────┘
    │               │                  │                   │
┌───▼─────┐  ┌──────▼───────┐  ┌───────▼────────┐  ┌───────▼─────────┐
│ Gmail   │  │ Pipeline     │  │ Decision Engine│  │ Store           │
│ Adapter │  │ (queue)      │  │ (DeepSeek)     │  │ Postgres+Prisma │
│         │  │              │  │                │  │                 │
│ OAuth   │  │ 1 sync       │  │ tier: flash    │  │ mails, threads  │
│ history │  │ 2 normalize  │  │ tier: pro      │  │ personas, rules │
│ labels  │  │ 3 prescore   │  │ JSON contract  │  │ decisions, evals│
│ push    │  │ 4 classify   │  │ cache + retry  │  │ pgvector (opt)  │
└─────────┘  │ 5 persist    │  └───────┬────────┘  └─────────────────┘
             │ 6 act back   │          │
             └──────────────┘   api.deepseek.com
                                 deepseek-flash
                                 deepseek-v4-pro
```

### 3.1 Component responsibilities

| Component | Owns | Never does |
| --- | --- | --- |
| **Gmail Adapter** | OAuth, incremental sync (`historyId`), label read/write, MIME fetch | Business logic, AI calls |
| **Normalizer** | MIME → clean text, quote/signature stripping, link + entity extraction, sanitization | Judgement |
| **Pre-Scorer** | Deterministic signal extraction → `SignalBundle` | Final routing |
| **Decision Engine** | DeepSeek calls, JSON validation, retry, tiering, budget guard, caching | Direct DB writes |
| **Pipeline** | Job orchestration, idempotency, backpressure, retries | UI concerns |
| **Store** | Persistence, indexes, decision history, feedback labels | External calls |

---

## 4. The Decision Contract

One mail in → one JSON decision out. This is the spine of the product; everything else is plumbing around it.

```jsonc
{
  "schemaVersion": 1,
  "messageId": "18f2...",
  "persona": {
    "primary": "work-client",
    "secondary": ["finance"],
    "confidence": 0.92,
    "suggestNewPersona": null   // e.g. { "name": "Legal", "reason": "..." }
  },
  "priority": {
    "band": "P1",               // P0 | P1 | P2 | P3
    "score": 87,                // 0-100, must equal trace.finalScore
    "deadline": "2026-09-24T17:00:00Z",
    "requiresReply": true,
    "requiresAction": true,

    // ---- the decision trace: every point of this score is attributable ----
    "trace": {
      "deterministicScore": 72,   // Pre-Scorer, before any model input
      "personaBias": 4,           // persona.priorityWeights applied here
      "modelAdjustment": 11,      // clamped to ±15, must be itemized below
      "finalScore": 87,           // 72 + 4 + 11, clamped 0-100
      "band": "P1",               // derived from finalScore via fixed bands

      "evidence": [
        { "signal": "directRecipient",     "label": "You were directly addressed",       "weight": 18, "source": "headers" },
        { "signal": "threadParticipation", "label": "You previously replied in this thread", "weight": 20, "source": "thread-history" },
        { "signal": "explicitDeadline",    "label": "Deadline detected: Thursday",       "weight": 18, "source": "text-rules", "value": "2026-09-24" },
        { "signal": "senderRelationship",  "label": "Known client contact",              "weight": 16, "source": "contacts" },
        { "signal": "listUnsubscribe",     "label": "Bulk mail header present",          "weight": -20, "source": "headers" }
      ],

      "adjustments": [
        { "delta": 7,  "reason": "Question is explicitly unanswered and time-sensitive beyond the detected deadline" },
        { "delta": 4,  "reason": "Contract language implies financial commitment" }
      ],
      "personaBiasDetail": [
        { "factor": "senderRelationship", "delta": 4, "reason": "Work — Client weights known-client senders higher" }
      ],
      "model": "deepseek-flash",
      "promptVersion": "v3",
      "cacheHit": true,
      "computedAt": "2026-09-21T09:14:02Z"
    }
  },
  "intelligence": {
    "tldr": "Client approves scope but wants the redline signed before Thu standup.",
    "asks": [
      { "text": "Sign the redlined SOW", "owner": "me", "due": "2026-09-24" }
    ],
    "keyFacts": [
      { "label": "Amount", "value": "$48,000" },
      { "label": "Contract", "value": "SOW v3" }
    ],
    "sentiment": "neutral-positive",
    "readingTimeSeconds": 22,
    "entities": {
      "people": ["Dana Reyes"],
      "orgs": ["Northwind Ltd"],
      "dates": ["2026-09-24"],
      "money": ["$48,000"],
      "links": ["https://…"]
    }
  },
  "trust": {
    "verdict": "legitimate",    // legitimate | marketing | noise | suspicious | phishing
    "isSpam": false,
    "isPhishing": false,
    "signals": [
      "SPF pass, DKIM pass, DMARC pass",
      "Display name matches known contact"
    ],
    "riskScore": 4,             // 0-100
    "warnings": []
  },
  "noise": {
    "isNoise": false,
    "category": null,           // newsletter | receipt | notification | social | promo
    "summaryLine": null         // one line for the collapsed digest
  },
  "confidence": {
    "overall": 0.94,
    "needsHumanReview": false
  }
}
```

**Rules for the contract**
- Validate against a Zod schema on every response. A schema failure is a retry, then a heuristic fallback — never a crash.
- `priority.score`, `trace.finalScore`, and `trace.band` must agree. If arithmetic fails to reconcile, the **deterministic** value wins, the model adjustment is discarded, and the row is flagged `inconsistent`.
- **The trace is mandatory and is recomputed by the server, not trusted from the model.** The model returns only `modelAdjustment` + itemized `adjustments`; the server owns `deterministicScore`, `personaBias`, the sum, and the band. A model can therefore never inflate its own influence or fabricate a band.
- Any `trust.verdict` of `suspicious`/`phishing` forces the mail out of the ranked queue into Quarantine, regardless of priority.
- `needsHumanReview: true` routes to a "Needs a look" lane instead of auto-archiving.

---

## 5. DeepSeek as the Decision Engine

### 5.1 API facts this design relies on

- Base URL `https://api.deepseek.com` (OpenAI-compatible).
- Models: **`deepseek-flash`** (bulk workhorse, supports vision and JSON output) and **`deepseek-v4-pro`** (harder reasoning; no vision). *Model names are config, not hardcoded* — they change; keep them in one enum.
- **JSON Output:** set `response_format: { "type": "json_object" }` and the word "json" must appear in the prompt, with a format example. Occasional empty content is a documented behavior → retry path required.
- **Context caching** gives cache-hit input pricing that is ~50× cheaper than cache-miss — a large win when a stable system prompt + persona definitions are reused across thousands of mails.
- **1M context** means a whole thread (or a whole inbox page) can be analyzed in one call instead of N calls.
- Off-peak pricing is half of peak — batch non-urgent backfill into off-peak windows.

### 5.2 Two-tier routing (the main cost lever)

```
Pre-Scorer SignalBundle
        │
        ├─ Hard rules decide ──────► skip AI entirely (blocklisted sender,
        │                             pure DMARC-fail, empty body + no links)
        │
        ├─ Trivial + high-certainty ─► deepseek-flash, non-thinking, batched
        │   (receipts, newsletters,       (up to N mails per call)
        │    calendar accepts)
        │
        ├─ Normal mail ─────────────► deepseek-flash, thinking on
        │
        └─ Ambiguous / high-stakes ─► deepseek-v4-pro, thinking on
            (money, legal, P0 candidate,
             phishing suspicion, low confidence,
             novel persona proposal)
```

Escalation to `pro` is triggered by: low flash confidence (<0.75), money/legal/deadline language, `trust.riskScore > 40`, or a persona the model wanted to invent.

### 5.3 Batching & caching strategy

- **Batch trivial mail** into a single flash call (array in, array out), keyed by content hash — cuts per-mail overhead dramatically.
- **Cache the invariant prefix**: system prompt + persona definitions + few-shot examples + user's writing style block. Keep it byte-identical across calls so cache hits land.
- **Thread-level calls**: when a mail belongs to a thread, send the thread digest once instead of each message's full body.
- **Idempotency key** = `hash(messageId + schemaVersion + promptVersion + modelId)`. Re-runs are free.

### 5.4 Budget & reliability guard

- Per-user daily token ceiling + per-run ceiling, enforced *before* dispatch.
- On `429` / `5xx`: exponential backoff with jitter, max 3 attempts, then heuristic fallback.
- Circuit breaker: sustained failures flip the app into "heuristic mode" with a visible banner.
- Every decision row records `model`, `promptVersion`, `tokensIn/Out`, `cacheHit`, `latencyMs`, `costUsd` → cost is observable per persona per day.

---

## 6. Personas

A **persona** is a hat the user wears, not a folder. It answers *"which version of me is this mail for?"*

### 6.1 Persona definition

```ts
type Persona = {
  id: string
  name: string                 // "Work — Client"
  icon: string                 // lucide icon name
  description: string          // shown to the model, this is the classifier's rubric
  senderPatterns: string[]     // domains/addresses that strongly indicate this persona
  keywords: string[]
  priorityWeights: {           // persona-specific ranking bias
    senderRelationship: number
    deadline: number
    money: number
    replyNeeded: number
  }
  quietHours?: { from: string; to: string }
  autoActions: {               // what the app may do without asking
    archiveNoise: boolean
    labelInGmail: boolean
    neverAutoArchive: boolean
  }
}
```

### 6.2 Starter persona set

| Persona | Signals | Typical weight |
| --- | --- | --- |
| **Work — Client** | Client domains, SOW/contract/proposal language | Highest priority bias |
| **Work — Internal** | Colleague domains, standup/PR/ticket language | High, but reply-needed gates it |
| **Founder / Ops** | Investors, legal, banking, hiring, vendors | High, money-sensitive |
| **Finance** | Invoices, statements, payment failures, tax | High for failures, P3 for receipts |
| **OSS / Dev** | GitHub, CI, mailing lists, issue trackers | Medium; collapses well |
| **Recruiter** | LinkedIn, "opportunity", staffing domains | Low, digest-only by default |
| **Personal** | Friends, family, known personal addresses | High, overrides quiet hours |
| **Noise** | Promos, newsletters, social notifications | Quarantined |

### 6.3 How persona is decided

1. Deterministic matches (`senderPatterns`) produce **candidate personas with prior scores**.
2. The candidate list *plus* the mail's cleaned content goes to DeepSeek.
3. The model returns `primary`, optional `secondary`, a `confidence`, and may propose a new persona (which surfaces as a suggestion chip — never auto-created).
4. User corrections are stored as **feedback examples** and injected as few-shots for that user (per-user personalization, not global retraining).

A mail may belong to several personas; **one primary** drives the lane, secondary ones surface as tags.

---

## 7. Priority Model

Priority is **hybrid**: deterministic evidence + model judgement, reconciled into a single band.

### 7.1 Deterministic signals (Pre-Scorer)

| Signal | Source | Weight |
| --- | --- | --- |
| Direct recipient (`To`, not `Cc`, not a list) | headers | +18 |
| Thread participation (user replied before) | thread history | +20 |
| Unanswered direct question | text heuristics | +22 |
| Explicit deadline / date commitment | date + regex parse | +18 |
| Money / legal / contract terms | lexicon | +12 |
| Calendar invite / RSVP pending | MIME parts | +14 |
| Sender in address book / prior 1:1 | contacts | +15 |
| `List-Unsubscribe` present | headers | −20 |
| `Precedence: bulk` / `Auto-Submitted` | headers | −25 |
| No-reply sender | headers | −18 |
| DMARC fail | auth headers | −30 (and quarantine candidate) |
| Repeat of an already-read thread | store | −10 |

These come out as `SignalBundle` — **numbered evidence, not prose** — and are handed to the model.

### 7.2 Final banding

```
deterministicScore = clamp(Σ evidence[].weight, 0, 100)     // Pre-Scorer, server-owned
personaBias        = apply(persona.priorityWeights)         // deterministic, server-owned
modelAdjustment    = clamp(Σ adjustments[].delta, -15, +15)  // model-owned, clamped
finalScore         = clamp(deterministicScore + personaBias + modelAdjustment, 0, 100)

P0  90-100  Act now — direct ask or hard deadline, ≤24h
P1  70-89   Today — needs a reply/decision, this week
P2  40-69   This week — informational but relevant to you
P3  0-39    Whenever — low-value, digest-eligible
```

The model may adjust by at most ±15 from the deterministic base and **must itemize every delta in `trace.adjustments`**.

### 7.3 The decision trace (auditability as a feature)

The trace is what makes the ranking *legible*. Three properties make it more than a log line:

1. **Additive by construction.** `deterministicScore + personaBias + modelAdjustment === finalScore`, asserted in code. If a decision doesn't reconcile, it's rejected and recomputed deterministically. There is no path to an unexplained score.
2. **Server-owned vs. model-owned is explicit.** `deterministicScore`, `personaBias`, the sum, and the band are computed by the server. The model only ever supplies clamped, itemized deltas. This is the structural defense against a model that flatters itself.
3. **Evidence carries its own weight.** Each entry names the signal, a human-readable label, its signed contribution, and its source (`headers`, `text-rules`, `thread-history`, `contacts`). The UI never has to invent an explanation — it renders the trace.

**Trace → UI mapping.** Every trace element is user-visible on demand and never fabricated at render time:

| Trace field | Rendered as |
| --- | --- |
| `evidence[]` positive | "You were directly addressed" `+18` |
| `evidence[]` negative | "Bulk mail header present" `−20` |
| `adjustments[]` | "Model adjustment: +7 — question is unanswered and time-sensitive" |
| `personaBiasDetail[]` | "Work — Client weights known clients higher: +4" |
| Arithmetic header | `72 + 4 + 11 = 87 → P1` |

**Trace persistence matters more than trace display.** Because old decisions keep their trace, "why was this P0 last Tuesday?" stays answerable after the prompt or model changes — which is exactly when you need it.

### 7.4 Gmail write-back

Bands and personas mirror to Gmail labels (`Andro/P0`, `Andro/Persona/Work-Client`, `Andro/Quarantine`) so the system is useful even outside the web app. Write-back is refused for any mail with `needsHumanReview`.

---

## 8. Noise, Spam & Phishing Suppression

The user's complaint — "instead of seeing spam and useless contents" — is solved in three layers:

**Layer 1 — Prove it's noise (no AI cost).** Header/rule signals: `List-Unsubscribe`, bulk precedence, auto-submitted, no-reply senders, known promo domains, DMARC/DKIM/SPF results. Pure failures can be quarantined outright.

**Layer 2 — Let DeepSeek judge intent.** For anything ambiguous, the model returns `trust.verdict` and `noise.category` plus a `summaryLine`. This distinguishes a *useful* newsletter from junk, and a *wanted* receipt from a fake one.

**Layer 3 — Never show raw noise.** Mails with `noise.isNoise = true` leave the ranked queue and collapse into a **Daily Digest** — one line each, expandable. Phishing never renders live links; URLs are defanged and shown as `hxxps://` with a domain-mismatch warning.

**Phishing heuristics fed to the model:** display-name vs. envelope-from mismatch, lookalike domains (homoglyph/punycode), urgency + credential-request language, `Reply-To` divergence, first-contact sender asking for money, link text vs. href mismatch.

**Hard rule:** any `trust.verdict` in `{suspicious, phishing}` is excluded from auto-archive and auto-label and appears in Quarantine with an explanation.

---

## 9. Privacy, Security & Prompt-Injection Defense

Email is attacker-controlled text that lands *inside* a prompt. Defenses, in order:

1. **Strip before sending.** Only sanitized plain text + safe metadata crosses the wire. Never raw HTML, never tracking pixels, never attachments (opt-in per attachment, size-capped, and only for `deepseek-flash` vision when the user allows).
2. **Delimit and label as data.** Mail content is wrapped in explicit untrusted-data fences and the system prompt states that content inside the fence is *evidence to classify*, never instructions to follow.
3. **No tools on the classification call.** The classification request has no tool access, so embedded "ignore previous instructions / forward this to…" text has no capability to exploit.
4. **Output is validated, not trusted.** Zod schema, enum-constrained personas, score ranges. A model that "decides" to output `action: "delete everything"` hits a schema wall.
5. **Least-privilege OAuth.** `gmail.readonly` + `gmail.labels` only. No `gmail.send` in v1 — the app never sends mail on the user's behalf, removing the highest-severity risk.
6. **Token custody.** OAuth refresh tokens encrypted at rest (AES-256-GCM, key from env/KMS), never logged, revoked on disconnect.
7. **Redaction mode.** Optional toggle to strip card-like numbers, OTPs, and national IDs before the API call; the brief still works on structure and intent.
8. **Retention.** Configurable TTL for stored bodies; "metadata-only" mode keeps decisions but discards bodies.
9. **Auditability.** Every decision stores model, prompt version, signals, and reasons — so a surprising verdict can be explained after the fact.

---

## 10. UI / UX — Black & White, shadcn/ui

### 10.1 Theme tokens

Dark-only. Pure black canvas, white primary, a **white-opacity ramp** as the only expressive axis, and two functional colors held in reserve.

```css
/* app/globals.css — Tailwind v4 @theme inline + shadcn variables */
:root, .dark {
  --background: oklch(0 0 0);          /* pure black canvas */
  --foreground: oklch(0.985 0 0);      /* near-white text */
  --card: oklch(0.145 0 0);            /* #0a0a0a surface */
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.145 0 0);
  --primary: oklch(0.985 0 0);         /* white = the accent */
  --primary-foreground: oklch(0.145 0 0);
  --secondary: oklch(0.205 0 0);
  --muted: oklch(0.205 0 0);
  --muted-foreground: oklch(0.65 0 0);
  --accent: oklch(0.269 0 0);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 12%);
  --ring: oklch(0.985 0 0 / 40%);
  --radius: 0.625rem;

  /* functional-only color — used nowhere decorative */
  --destructive: oklch(0.58 0.22 27);  /* P0 / phishing / danger */
  --warning:     oklch(0.75 0.15 75);  /* soft deadline */
}
```

**Priority is expressed in monochrome**, so it stays on-theme:

| Band | Treatment |
| --- | --- |
| P0 | Solid white 2px left rail + white band badge on black |
| P1 | 70% white rail |
| P2 | 35% white rail |
| P3 | 15% white rail, muted text |
| Quarantine | `--destructive` rail + shield icon |

Typography: **Geist Sans** for UI, **Geist Mono** for amounts, IDs, and deadlines. Icons: **lucide**. Motion: minimal — 120ms fades, no bounce.

### 10.2 Layout — three panes

```
┌──────┬───────────────────────────────────┬─────────────────────────────┐
│      │  ⌘K  Search / Command             │   Intelligence Brief        │
│ ◉    │  ┌─────────────────────────────┐  │                             │
│ Work │  │ ● P0  Client · Contract     │  │  TL;DR                      │
│ ◎    │  │   Northwind redline …       │  │  Client approves scope but  │
│ Found│  │   Thu · 2 asks · 22s read   │  │  wants signature by Thu.    │
│ ◇    │  ├─────────────────────────────┤  │                             │
│ Fin  │  │ ○ P1  Internal · Standup    │  │  ASKS                       │
│ ⌗    │  │   …                         │  │  ☐ Sign redlined SOW  Thu   │
│ OSS  │  ├─────────────────────────────┤  │                             │
│ ☰    │  │ ○ P2  …                     │  │  FACTS                      │
│ Noise│  └─────────────────────────────┘  │  Amount  $48,000            │
│      │                                   │  Contract SOW v3            │
│ ⚙    │  ── Noise · 34 collapsed ──       │  ▼ Original (sanitized)     │
└──────┴───────────────────────────────────┴─────────────────────────────┘
  persona                    triage queue              brief
   rail                    (priority-ranked)         (streamed)
```

### 10.3 shadcn components used

`Sidebar` (persona rail), `Command` (⌘K palette — primary navigation), `Resizable` (3-pane split), `Card`, `Badge`, `Tabs`, `ScrollArea`, `Separator`, `Sheet` (mobile), `Tooltip`, `Skeleton`, `Sonner` (toasts), `Progress` (budget meter), `Avatar`, `Dialog`, `Table` (noise digest), `DropdownMenu`, `Switch` (rules), `Chart` (priority distribution / cost).

### 10.4 Key screens

1. **Focus** (default) — only P0/P1 plus anything with an open ask. The "what needs me now" view.
2. **Persona lanes** — same queue filtered by persona; each lane shows its own unread high-priority count.
3. **Command palette (⌘K)** — jump to persona, mail, action (`archive all P3 in OSS`).
4. **Intelligence Brief pane** — streamed TL;DR → asks → facts → entities → sanitized original. DeepSeek output renders progressively so it feels instant.
5. **Noise & Quarantine** — collapsed digest table; phishing rows carry warnings and defanged links.
6. **Daily Digest** — AI rollup of everything P3/noise: "12 receipts, 3 newsletters, 1 GitHub mention, $214 spent."
7. **Persona & Rules editor** — persona rubric, sender patterns, priority weights, auto-action switches, with live "test this rule against my last 200 mails".
8. **Insights** — priority distribution, response-time trend, AI cost per persona (Progress meter against budget).
9. **Settings / Privacy** — redaction toggle, retention TTL, metadata-only mode, model tier, disconnect/revoke.

### 10.5 Interaction principles

- **Keyboard first:** `j/k` navigate, `e` archive, `s` snooze, `1-4` set priority, `⌘K` palette, `Esc` back. The mouse is optional.
- **Streaming briefs:** TL;DR renders first, facts after — perceived latency over raw latency.
- **Explain every verdict.** A `Why?` affordance opens the **decision trace**, not a generic blurb. Legibility is the product's trust surface.

  ```
  ┌─ Why P1? ───────────────────────────────┐
  │  72  +  4  +  11  =  87   →  P1         │   ← arithmetic header, always shown
  │  deterministic  persona  model          │
  ├─────────────────────────────────────────┤
  │  EVIDENCE                               │
  │  +20  You previously replied in this    │
  │       thread             thread-history │
  │  +18  You were directly addressed       │
  │                          headers        │
  │  +18  Deadline detected: Thursday       │
  │                          text-rules     │
  │  +16  Known client contact   contacts   │
  │  −20  Bulk mail header present          │
  │                          headers        │
  ├─────────────────────────────────────────┤
  │  PERSONA · Work — Client          +4    │
  │  Weights known-client senders higher    │
  ├─────────────────────────────────────────┤
  │  MODEL · deepseek-flash           +11   │
  │  +7  Question is unanswered and         │
  │      time-sensitive beyond the deadline │
  │  +4  Contract language implies          │
  │      financial commitment               │
  ├─────────────────────────────────────────┤
  │  judged 09:14 · prompt v3 · cached      │
  └─────────────────────────────────────────┘
  ```

  Three details that make this feel trustworthy rather than magical: the **arithmetic is shown, not implied** (`72 + 4 + 11 = 87`); the model's contribution is **visually separated from deterministic fact** and capped at ±15, so its influence is bounded and visible; and every line carries a **source tag**, so the user can tell "the header said this" apart from "the model inferred this."
- **Disagreement is a first-class signal.** When the user re-sets a priority, the trace shows exactly which evidence contributed to the wrong band — which is what makes §13's feedback loop a *targeted* correction instead of a thumbs-down.
- **Optimistic + undo.** Actions apply instantly with a Sonner undo window; Gmail write-back reconciles in the background.
- **Confidence is visible.** `needsHumanReview` mails get a subtle marker instead of a false sense of certainty.

---

## 11. Data Model (Prisma / Postgres)

```prisma
model Account       { id, userId, provider, email, encryptedRefreshToken, historyId, syncState }
model Thread        { id, accountId, gmailThreadId, subject, participants[], lastMessageAt }
model Message       { id, threadId, gmailMessageId, from, to[], cc[], receivedAt,
                      snippet, cleanBody, bodyTtl, hasAttachments, sizeBytes,
                      authResults Json, headers Json, contentHash, decisionId? }
model Persona       { id, userId, name, icon, description, senderPatterns[], keywords[],
                      priorityWeights Json, quietHours Json, autoActions Json, isSystem }
model Decision      { id, messageId, schemaVersion, personaPrimary, personaSecondary[],
                      priorityBand, priorityScore, deadline,
                      requiresReply, requiresAction, tldr, asks Json, keyFacts Json,
                      trustVerdict, isSpam, isPhishing, riskScore, warnings[],
                      isNoise, noiseCategory, summaryLine,
                      confidence, needsHumanReview, escalatedToPro, isInconsistent,
                      model, promptVersion, tokensIn, tokensOut, cacheHit, latencyMs, costUsd,
                      createdAt }
model DecisionTrace { id, decisionId, deterministicScore, personaBias, modelAdjustment, finalScore,
                      band, evidence Json, adjustments Json, personaBiasDetail Json,
                      model, promptVersion, cacheHit, computedAt }
model SignalBundle  { id, messageId, signals Json, baseScore, computedAt }
model Feedback      { id, userId, messageId, field, aiValue, userValue, createdAt,
                      traceSnapshot Json }   // which evidence drove the wrong answer
model Rule          { id, userId, priority, matcher Json, action Json, enabled }
model Digest        { id, userId, date, digestJson, messageCount, generatedAt }
```

**Why `DecisionTrace` is its own table:** it is append-only and never mutated, so it can be written once and read cold. Keeping it out of `Decision` means the hot triage queries (`band`, `createdAt`) don't drag a fat JSON blob through every scan, while the trace stays available for the `Why?` panel and for post-hoc analysis of prompt changes.

Indexes that matter: `Message(contentHash)`, `Decision(priorityBand, createdAt)`, `Decision(personaPrimary, priorityBand)`, `DecisionTrace(decisionId)` (unique), `Message(threadId, receivedAt)`. Optional `pgvector` on `Message` embeddings for near-duplicate collapse and semantic search.

---

## 12. Pipeline Flow

```
Gmail push/webhook ─► enqueue sync(historyId)
        │
        ▼
   fetch new message IDs           
        │
        ▼
   Normalizer: MIME → clean text, strip quotes/signature, extract links + entities
        │
        ▼
   Sanitizer: remove HTML/tracking, redact per settings, wrap in untrusted-data fence
        │
        ▼
   Pre-Scorer: SignalBundle + deterministic base score   ── hard reject? ─► Quarantine (no AI)
        │
        ▼
   Idempotency check (contentHash + promptVersion + modelId) ── hit? ─► reuse Decision
        │
        ▼
   Router: flash-batch | flash | pro-escalate
        │
        ▼
   Decision Engine → JSON → Zod validate ── fail ─► retry ×3 ─► heuristic fallback
        │
        ▼
   Reconcile: assert deterministic + persona + model === final; band from final;
              persona vs patterns; trust gate   ── mismatch ─► drop model adjustment,
                                                  recompute deterministic, flag inconsistent
        │
        ▼
   Persist Decision + DecisionTrace + SignalBundle
        │
        ▼
   Side effects: Gmail labels / archive, digest bucket, UI invalidation, cost ledger
```

Jobs run on a queue (`BullMQ` + Redis, or `pg-boss` to avoid extra infra in v1) with per-user concurrency caps so one giant mailbox can't starve others.

---

## 13. Evaluation & Quality

Shipping an AI decision-maker without measurement is guesswork.

- **Golden set:** ~200 hand-labeled mails spanning all personas, including 30 phishing/spam and 20 deliberately ambiguous ones.
- **Metrics:** persona accuracy, priority band agreement (±1 band counts as near-miss), P0 precision (false-P0 is the expensive error), phishing recall (target ≥0.98), noise precision.
- **Trace metrics:** 100% of decisions must reconcile arithmetically; mean |modelAdjustment| (a rising value means the deterministic Pre-Scorer is underfit and should absorb that signal); % of decisions where the model overrode the deterministic band (should stay low — a high override rate means the model, not the rules, is really doing the ranking).
- **Trace-driven error analysis:** when the golden set disagrees with the model, the trace attributes the miss to a specific signal. That turns "the AI got it wrong" into "`explicitDeadline` misfires on relative dates" — a fixable rule, not a prompt-tuning guess.
- **Regression gate:** every prompt or model change re-runs the golden set in CI; merge blocked on P0-precision or phishing-recall regression.
- **User feedback loop:** corrections on persona/priority are stored with a `traceSnapshot` of what drove the original answer, and replayed as per-user few-shots.
- **Drift watch:** weekly sample review + confidence histogram; a spike in `needsHumanReview` means the prompt or model changed behavior.
- **Cost metrics:** $ per 1,000 mails, cache-hit rate, % escalated to pro, off-peak batch share.

---

## 14. Milestones

| # | Milestone | Deliverable | Acceptance criteria |
| --- | --- | --- | --- |
| **M0** | Scaffold & theme | Next.js + Tailwind v4 + shadcn/ui, dark-only monochrome tokens, app shell with 3 panes | Shadcn components render correctly on pure black; no light-mode flash; contrast AA on all text |
| **M1** | Gmail ingest | OAuth (readonly + labels), incremental sync, Normalizer, Store | 1,000 real mails ingested with clean text; re-sync is idempotent |
| **M2** | Pre-Scorer | SignalBundle extraction + deterministic base score, rules engine | Rules alone sort the golden set to ≥70% band agreement; noise hard-rejects are correct |
| **M3** | Decision Engine | DeepSeek client, JSON contract + Zod, two-tier routing, **server-side trace reconciliation**, retry, cost ledger | 95% of golden set returns schema-valid decisions; **100% of traces reconcile arithmetically**; cost per 1k mails measured and under budget |
| **M4** | Triage UI | Persona rail, priority queue, Focus mode, keyboard nav, Command palette, **`Why?` trace panel** | A user can clear 50 mails without the mouse; every verdict opens a trace showing arithmetic, evidence with sources, and the itemized model adjustment |
| **M5** | Intelligence Brief | Streamed TL;DR/asks/facts/entities + sanitized original | Brief is useful on 90% of sampled P0/P1 mails (user-rated) |
| **M6** | Trust & Noise | Quarantine, defanged links, phishing warnings, Daily Digest | Phishing recall ≥0.98 on golden set; zero live links rendered in quarantine |
| **M7** | Personas & Feedback | Persona editor with 200-mail rule tester, correction capture, per-user few-shots | Editing a persona visibly reclassifies matching mail; corrections persist |
| **M8** | Privacy & Insights | Redaction, retention TTL, metadata-only mode, cost/priority dashboards | Tokens encrypted at rest; disconnect revokes and purges |
| **M9** | Hardening | Prompt-injection test suite, circuit breaker, load test, a11y pass | Injected-instruction suite yields zero unauthorized actions; graceful degrade verified |

**Suggested build order:** M0 → M1 → M2 → M3 → M4 (usable heuristic + AI inbox) → M5 → M6 → M7 → M8 → M9.
M0–M4 is the smallest end-to-end slice worth demoing.

---

## 15. Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Prompt injection via email body | High | No tools on classify calls, data-fenced content, Zod-validated output, no `gmail.send` scope |
| Misclassified P0 (missed urgent mail) | High | Hybrid deterministic+AI scoring, ±15 model cap, `needsHumanReview` lane, P0 precision gate in CI |
| Cost blowout on large mailboxes | Medium | Two-tier routing, batching, context caching, hard budget ceiling, heuristic fallback |
| DeepSeek outage / model rename | Medium | Model names in config, circuit breaker, heuristic mode, multi-provider-ready client interface |
| Gmail API quota / OAuth verification | Medium | Incremental `historyId` sync, request batching, backoff, start in testing mode with allow-listed users |
| Privacy discomfort with cloud AI | Medium | Redaction mode, metadata-only mode, TTL, explicit consent screen, local-only option later |
| Persona sprawl / stale personas | Low | Suggestion chips instead of auto-create, usage stats per persona, archive unused |
| Monochrome theme hurts priority scanning | Low | White-opacity ramp + reserved destructive color, validated with a11y contrast pass |

---

## 16. Open Questions

1. **Attachments & images** — should `deepseek-flash` vision process image attachments (screenshots, scanned invoices) by default, or opt-in per mail?
2. **Write-back scope** — labels only in v1, or also archive/mark-read? (Drafting replies stays out until trust is established.)
3. **Multi-account** — one mailbox per user for v1, or n-account from the start? Affects the Account/Thread model.
4. **Digest cadence and channel** — daily in-app only, or also an email summary? (Ironically the one mail we'd send.)
5. **On-device vs cloud** — is metadata-only mode sufficient for privacy-sensitive users, or is a local-model path required?
6. **Persona sharing** — exportable persona presets (e.g. a "Freelancer" template) or strictly personal?

---

## 17. Definition of Done (v1)

- [ ] Gmail connects via least-privilege OAuth; tokens encrypted; disconnect purges.
- [ ] Mail syncs incrementally and idempotently.
- [ ] Every mail receives a Zod-valid decision with persona, priority, intel, and trust verdict.
- [ ] Deterministic + AI scoring reconciled; every band is explainable via `Why?`.
- [ ] Every ranked mail has a persisted `DecisionTrace` whose arithmetic reconciles exactly, with server-owned deterministic/persona terms and clamped, itemized model deltas.
- [ ] The `Why?` panel shows the arithmetic, separates fact from inference, and tags every line with its source.
- [ ] Noise collapses into Daily Digest; phishing is quarantined with defanged links.
- [ ] UI is dark-only black/white shadcn, fully keyboard-navigable, three-pane.
- [ ] Golden-set gates pass: P0 precision, phishing recall ≥0.98, schema validity ≥0.99.
- [ ] Cost per 1,000 mails measured, bounded, and visible in the UI.
- [ ] Prompt-injection test suite passes with zero unauthorized actions.
- [ ] DeepSeek outage degrades to heuristic mode without data loss or silent mis-ranking.

---

*Sources: [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode), [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing), [shadcn/ui dark mode](https://ui.shadcn.com/docs/dark-mode). Verify model names and pricing before build — they change.*
