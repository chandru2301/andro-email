# REVIEW.md — external review of PLAN.md

Reviewed 2026-09-21. Sources checked live: DeepSeek Models & Pricing, DeepSeek Vision guide, DeepSeek V4-Flash-Vision-Exp release note.

## Verdict

Engineering spec: strong. Product plan: has no customer in it.
The doc spends 569 lines on *how* and zero lines on *who pays and why*. Every §16 Open Question is implementation detail.

## Keep (defensible in an interview)

- §4 Decision Contract — one structured verdict per mail, everything else is plumbing.
- §7.1 Pre-Scorer as numbered evidence handed to the model, not left to guess.
- §7.2 ±15 model-adjustment cap with mandatory `priority.reasons`.
- §5.2 two-tier routing as the cost lever.
- §5.4 budget guard + circuit breaker → heuristic mode.
- §9.3-9.5 no tools on the classify call, Zod-validated output, `gmail.readonly` + `gmail.labels` only, no `gmail.send`.
- §13 golden set with a CI regression gate on P0 precision and phishing recall. Best idea in the document.

## Corrections (the plan is factually stale on one load-bearing point)

1. **Vision does not exist in the API.** `deepseek-flash` is the correct current model name. But `deepseek-v4-flash-vision-exp` was retired; per the pricing page's own note, requests to the legacy names are now served by DeepSeek-V4.1-Flash (text-only) and billed at Flash price. §5.1's "supports vision and JSON output", §9.1's opt-in attachment path, and §16 Q1 are all built on a capability that is gone. Images were also images-only (JPEG/PNG/GIF/WebP), never PDF — so "scanned invoices" never worked as described.
   → Delete attachment/vision support from v1. If needed later: OCR locally, send text.
2. **Cache-hit claim is right.** ~30-50x cheaper than cache-miss (peak $0.44 vs $0.014 in; off-peak $0.22 vs $0.007). Keep §5.3.
3. **Peak hours in IST.** Peak = 01:00-04:00 and 06:00-10:00 UTC Mon-Fri = **06:30-09:30 and 11:30-15:30 IST**. Most of an Indian workday is peak; off-peak is exactly half. "Batch non-urgent backfill off-peak" means after 15:30 IST. Put this in the budget guard, not in prose.
4. **V4 Pro** survived the Sept 14 2026 cutoff on a "continued provision" notice. The config-enum instinct (§5.1) is correct; keep it.
5. **`gmail.readonly` is a restricted scope.** Past ~100 users it needs Google's CASA security assessment — weeks of calendar time and real money. This gates *distribution*, not just auth. §15 rates it "Medium"; it is a hard gate.
6. **Missing:** Gmail `historyId` expiry needs a full-resync fallback; running a 200-mail golden set in CI on every PR has real $ and latency cost (make it nightly, or prompt-version-change only).
7. **Implement the ±15 cap in code**, not by trusting the model to self-limit: model returns a score, the reducer clamps it.
8. **Eval should report per-persona**, not just aggregate — one heavy persona (Work-Client) and several thin ones will mask a bad thin lane. Also add "known-urgent mail landed P3" cases: false-P0 is loud, a hidden P3 deadline is the quiet, expensive one.

## Cuts if it gets built

- Drop attachments/vision entirely (§16 Q1 deleted).
- M7 persona editor → hand-edited JSON config file in v1.
- M8 privacy/insights → mostly out of v1.
- Add a §0: three named "who pays and why" hypotheses + an explicit kill criterion.

## Recommended cut (chosen when no answer came back)

**Park the full build. Do not start M0-M9.**

Reasoning: zero income, an active 15 LPA sprint, and Andro's discovery month with 9 days left. M0-M9 is 2-3 months solo part-time, in the most crowded AI category there is (Gmail free, Superhuman, Shortwave, SaneBox, Fyxer, Notion Mail). Persona lanes and a monochrome ramp are UI, copyable in a week. Nothing here is a moat.

Two ideas are worth carrying into work that already has a deadline:

- The **pre-scorer → numbered evidence → capped model adjustment** pattern, reusable anywhere a model ranks things (Andro's cross-source conflict detection included).
- The **golden set + regression gate on the expensive error**: label ~50 real items, pick the error that actually hurts, gate CI on it. That's the thing that turns an LLM feature from vibes into a system — and it's the most convincing thing you can say in a GenAI interview.

If it is revived, revive it as the portfolio slice, not the product: M1 + M2 + M3 + M5 only (Gmail ingest → pre-scorer → DeepSeek JSON decision → streamed brief), ~2 weeks, no Postgres/BullMQ/pgvector, no multi-user OAuth, no privacy modes. Publish the eval table and the cost-per-1k-mails number in the README. The asset is the writeup, not the app.
