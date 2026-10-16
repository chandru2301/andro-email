# Andro Email

Persona-aware, priority-ranked email triage with an **auditable AI decision trace**.

An inbox stops being a list of senders and subjects and becomes a triaged queue:
*who is this for* (persona), *how much does it matter* (priority), and *what does
it actually want* (intelligence brief) — with every point of the priority score
attributable to a specific piece of evidence.

Runs with **zero configuration**. No API key, no database server, no OAuth.

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

On first load it seeds a 29-message fixture inbox (clients, internal, founder,
finance, open source, recruiter, personal, newsletters, receipts and four
phishing attempts) and ranks it with the deterministic rules engine.

---

## The idea

Naive AI email tools bolt a summary onto the top of the inbox. This one makes a
**decision** and then shows its work.

| | |
|---|---|
| **DeepSeek decides** | Persona, priority band, spam/phishing verdict and action items are one structured JSON decision per mail. |
| **The server does the arithmetic** | The model contributes *only* an itemized, clamped ±15 adjustment. Deterministic score, persona bias, the sum and the band are computed in `reconcile.ts`. A model can never inflate its own influence. |
| **Every score is attributable** | The `Why?` panel shows `71 + 8 + 15 = 94 → P0`, lists each piece of evidence with its weight and source, and separates *"the header said this"* from *"the model inferred this"*. |
| **Noise never reaches you** | Bulk mail collapses into a daily digest. Phishing is quarantined with defanged, non-clickable links. |
| **Nothing is silently dropped** | When DeepSeek is unreachable or unconfigured, the rules engine takes over and every decision is labelled `rules engine — no model judgement applied`. |

---

## Quick start

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000.

### Connect your real mailbox (app password)

No Google Cloud project, no OAuth consent screen. An **app password** authorises
IMAP directly against your mailbox.

**1. Create the app password** (Gmail requires 2-Step Verification first):

- <https://myaccount.google.com/security> → enable **2-Step Verification**
- <https://myaccount.google.com/apppasswords> → create one for "Mail"
- Google shows 16 characters as four groups (`abcd efgh ijkl mnop`)

**2. Fill in `.env.local`** — only the first two lines matter:

```ini
IMAP_USER=you@gmail.com
IMAP_PASSWORD=abcdefghijklmnop
```

**3. Verify the credentials before syncing anything:**

```bash
pnpm imap:check
```

```
  Connecting to imap.gmail.com:993 as you@gmail.com …
  ✓ Connected. 14 mailboxes visible.
    INBOX, [Gmail], [Gmail]/All Mail, …
  ✓ INBOX holds 2,481 messages.

  Newest 10:

    2026-09-21  dana@northwind.co      Re: Proposal: mobile transaction filtering
    2026-09-21  billing@stripe.com     Payment could not be processed
    …

  9 inbound, 1 sent by you.
```

**4. Restart and sync.** `pnpm dev`, then press **Sync now** in the sidebar (or
just reload — an empty database syncs on first request). The sidebar shows which
mailbox is being read; **Test connection** re-checks the credentials from the UI.

Only the newest `IMAP_LIMIT` messages are pulled (default 60). Re-syncing is
idempotent: mail whose content and prompt version are unchanged is **not** sent
to the model again, so pressing Sync twice does not cost twice.

> **Before you point this at a real inbox:** `IMAP_PASSWORD` is a long-lived
> secret with full mailbox access. It is read from the environment only, never
> written to the database, never logged, and sent nowhere but the IMAP server.
> `.env*` is gitignored — keep it that way. If you ever want to revoke it, delete
> the app password in your Google account.

### With DeepSeek

```bash
# same .env.local
DEEPSEEK_API_KEY=sk-...
```

The sidebar shows which engine is live. With a key, `deepseek-flash` handles the
bulk and escalates to `deepseek-v4-pro` when confidence drops, phishing risk
rises, or the mail involves money or contracts. Without one, the deterministic
rules engine ranks everything and says so.

### Keyboard

`j` / `k` move · `e` archive · `#` delete · `1`–`4` set priority P0–P3 · `/` filter · `Esc` clear

### Filing mail

Every row has **Archive** and **Delete** controls (they appear on hover, or use
the keys above), and the brief pane shows labelled buttons for whichever lane you
are in.

| Lane | Actions |
|---|---|
| Queue | **Archive** (hide, keep) · **Delete** (move to trash) |
| **Archived** | **Restore** to the queue · **Delete** |
| **Trash** | **Restore** · **Delete forever** (confirmed) |

**None of this touches your Gmail mailbox.** The IMAP source is read-only, so
archive and delete are *local* filing decisions — the sidebar says so in each
lane's subtitle, and the confirmation dialog repeats it. The flags persist, so a
later sync will not put filed mail back in the queue.

`Delete forever` and `Empty trash` remove the message, its decision and its trace
from the local database. Both are confirmed first. Because Gmail is untouched, a
future sync will re-import anything you purged — purging is for clearing your
local view, not for managing your mailbox.

### Other IMAP providers

Set `IMAP_HOST`, `IMAP_PORT` and `IMAP_SECURE` for anything else. Port 143 with
`IMAP_SECURE=false` uses STARTTLS. To include archived mail, set
`IMAP_MAILBOX="[Gmail]/All Mail"`.

---

## How a mail becomes a decision

```
Gmail / fixtures
      │
      ▼  normalize      strip HTML, quoted history, signature → sanitized text
      ▼  pre-score      deterministic evidence with signed weights  (SignalBundle)
      ▼  route          flash │ pro │ rules
      ▼  decide         DeepSeek returns JSON, Zod-validated
      ▼  reconcile      server computes the score, band and trace
      ▼  persist        Decision + append-only DecisionTrace
      ▼  act            Gmail labels, digest bucket, quarantine
```

**Pre-scoring is the anchor, not (yet) a filter.** Rules establish *legitimacy
and relationship* (direct recipient, thread participation, known domain, bulk
headers, SPF/DKIM/DMARC); the model adjudicates *urgency of the ask*, but only
within the ±15 the trace allows.

> **Every inbound message is currently sent to DeepSeek when a key is set.** There
> is no pre-API gate: `toAnalyze` is every message not authored by you. The
> pre-scorer's output is sent *as evidence* rather than used to skip the call.
> The two-tier skip and the request batching described in `PLAN.md` §5.2–5.3 are
> **not implemented** — so the per-message cost below assumes one API call per
> mail. See "Cost and privacy" at the end of this file.

**Reconciliation is the trust mechanism.** One model response can produce an
unexplained score. Here it cannot: `deterministicScore + personaBias +
modelAdjustment === finalScore` is asserted, and `/api/health` re-checks it for
every persisted decision, returning HTTP 500 if any trace fails to reconcile.

---

## Seeing it work

```bash
curl -s localhost:3000/api/health | jq
```

```jsonc
{
  "ok": true,
  "engine": "heuristic",
  "counts": { "ranked": 20, "noise": 6, "traced": 26, "modelAdjustmentCapped": 0 },
  "bands": { "P0": 3, "P1": 3, "P2": 9, "P3": 11 },
  "traceFailures": []
}
```

What the fixture corpus produces with the rules engine alone:

| Band | Message | Why |
|---|---|---|
| **P0** | *Re: Proposal: mobile transaction filtering* | direct + thread participation + deadline + contract language |
| **P0** | *Strata Labs — payment of $18,500 could not be processed\** | payment failure |
| **P1** | *Kickoff: Lumen platform migration* | direct + known client + deadline |
| **P1** | *Ticket assigned: RW-1904* | colleague + open question |
| quarantine | *Updated remittance advice and banking information* | SPF/DKIM/DMARC fail + payment-redirection language |
| quarantine | *RE: Proposal: mobile transaction filtering* | `northwlnd.co` is a one-character lookalike of `northwind.co` |
| digest | *The Weekly Circuit #88*, GitHub notifications, receipts | bulk headers, no relationship |

\* Note the deliberate design: a failed-payment alert arrives from a no-reply
automated sender with `List-Unsubscribe` and `Precedence: bulk`. Naive rules —
including this project's first version — file it as marketing. The bulk
penalties total −73, so `paymentFailure` exempts the message from all of them.
Misfiling this as noise is the *quiet, expensive* error that a false-P0 headline
never reveals.

---

## Layout

```
src/
  app/
    page.tsx              server-rendered triage screen
    actions.ts            server actions: archive, re-rank, re-analyze
    api/health/route.ts   trace-invariant self-check
    globals.css           dark-only monochrome tokens
  components/
    triage-app.tsx        shell: lanes, filtering, keyboard
    persona-rail.tsx      persona lanes + engine status
    mail-list.tsx         priority-ranked queue
    brief-pane.tsx        Brief / Why? / Original
    why-panel.tsx         ← the decision trace, rendered
    band-badge.tsx        monochrome priority ramp
    ui/                   18 shadcn/ui primitives
  lib/
    types.ts              domain types + band thresholds
    contract.ts           Zod decision contract (model-owned subset)
    config.ts             model names, pricing, peak hours, budget
    personas.ts           8 persona definitions (the classifier's rubric)
    db/                   node:sqlite schema + repository
    pipeline/
      normalize.ts        sanitization, quote/signature stripping
      prescorer.ts        deterministic evidence + weights
      reconcile.ts        ← server-owned trace arithmetic and caps
      engine.ts           tier routing, escalation, degradation
      engines/            deepseek.ts · heuristic.ts
      run.ts              orchestration, concurrency, per-message isolation
    sources/              imap.ts (app password) · gmail.ts (OAuth) · mock.ts (fixtures)
    fixtures/corpus.ts    29-message seed inbox
scripts/
  imap-check.mjs          credential check: pnpm imap:check
  state-test.mjs          archive/delete/restore/purge regression test:
                          pnpm test:state (runs against a scratch database)
```

---

## Design decisions worth knowing

**Monochrome is the interface.** Priority is a white-opacity ramp
(`rail-p0` solid → `rail-p3` 15%), not a colour scale. Colour is reserved and
functional: `--destructive` for phishing and quarantine, `--warning` for
deadlines. The app is dark-only — there is no light theme to fall back to.

**The trace is a separate, append-only table.** It never mutates and is not in
the hot triage query, so *"why was this P0 last Tuesday?"* stays answerable after
the prompt changes — exactly when you need it.

**SQLite over Postgres.** `PLAN.md` specified Prisma + Postgres. A single file
via Node's built-in `node:sqlite` means the whole pipeline and the eval harness
run with no external services. See "Scope" below.

**Prompt injection is treated as a live threat.** Mail is sanitized, fenced and
labelled as data; the classification call has **no tools**; responses are
Zod-validated against enums; and OAuth is `gmail.readonly` + `gmail.labels` with
**no `gmail.send`**, so the highest-severity action is structurally impossible.

---

## Gmail (optional)

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` to
enable the live source. The adapter is complete — OAuth code exchange, token
refresh, incremental `historyId` sync with a full-resync fallback on expiry, and
MIME walking that prefers `text/plain`.

> **Distribution caveat.** `gmail.readonly` is a Google *restricted* scope. Past
> a handful of users it requires a CASA security assessment. That gates
> distribution, not local development — in testing mode you add yourself as a
> test user and it works immediately.

---

## Scope

This implements **M0–M4** of `PLAN.md`: scaffold and theme, Gmail + fixture
ingest, pre-scorer, decision engine with a persisted trace, and the triage UI
with the `Why?` panel. It also includes the eval hooks that matter.

Deliberately **not** built, and why:

- **Attachments and vision.** The Flash vision endpoint was retired; images
  never supported PDFs, so "scanned invoices" never worked as described.
- **Postgres / BullMQ / pgvector / multi-user OAuth.** Infrastructure that buys
  nothing at this scale; the pipeline runs in-process with bounded concurrency.
- **Persona editor UI.** Personas are a typed config file (`src/lib/personas.ts`).

`REVIEW.md` in this repo argues the product should not be built at all — the
inbox is crowded and none of this is a moat. The counter-position is that the two
transferable ideas are worth having as working code: the *pre-scorer → numbered
evidence → capped model adjustment* pattern, and the trace invariant as a
correctness gate. That is what this repository demonstrates.

---

## Cost and privacy

Because every inbound message is sent to DeepSeek, the honest question is what
that costs and what it exposes.

**Cost.** Measured against a real 60-message inbox (average body 3.2k chars,
largest 12k), using one call per message and the prices in `src/lib/config.ts`:

| | Per message | Per 1,000 |
|---|---|---|
| `deepseek-flash`, no cache | $0.00114 | **$1.14** |
| `deepseek-flash`, system prompt cached | $0.00080 | **$0.79** |
| off-peak (half price), cached | $0.00040 | **$0.40** |

A 60-message sync is about **$0.05**. A full 2,500-message backfill is about
**$2.00**. Cost is not the reason to hold back — and roughly 1,170 tokens of
every call is the identical system prompt (persona rubric + JSON example), which
is exactly what DeepSeek's context caching is for.

**Privacy.** This is the real tradeoff, and it is not theoretical: the request
body contains the message text. What reduces that today —

- only sanitized **plain text** is sent; HTML, tracking, quoted history and
  signature blocks are stripped in `normalize.ts` before anything leaves
- the call has **no tools**, so injected instructions have nothing to act on
- nothing is written back to the mailbox

What is **not** mitigated today —

- **no redaction.** One-time passcodes, card numbers and national IDs go to the
  API verbatim. If your inbox contains verification codes, they leave the machine.
- **no metadata-only mode** — the body is always included.
- **no local-model path.**
- Only the newest `IMAP_LIMIT` messages are pulled, so scope is bounded by
  configuration rather than by policy.

To reduce exposure today, lower `IMAP_LIMIT` and point `IMAP_MAILBOX` at a
dedicated label instead of `INBOX`. `PLAN.md` §9 specifies redaction, retention
TTL and a metadata-only mode; none are implemented.

---

## Known limitations

Honest state of the rules engine, from the seeded corpus:

- *"Sunday call?"* and *"Heads up: design system migration"* land in
  **Work — Internal** rather than **Personal**. A colleague writing from a
  personal address is genuinely ambiguous without a contacts graph.
- *"Appointment reminder — Tuesday, September 22"* scores **P3**. The rules see
  no reply request and no bulk signal; a human would call it P1. This is the kind
  of judgement the DeepSeek path exists to add.
- The signal weights in `prescorer.ts` are **hand-calibrated**, not fitted. The
  calibration targets are documented at the top of that file.

There is no golden set yet. `PLAN.md` §13 specifies one — roughly 200 labelled
messages gating CI on per-persona accuracy, P0 precision, and phishing recall
≥ 0.98 — and the `/api/health` invariant is the piece of that harness that is
already real.
