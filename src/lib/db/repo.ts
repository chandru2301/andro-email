import type {
  Address,
  DailyDigest,
  Decision,
  DecisionTrace,
  Message,
  PriorityBand,
  SignalBundle,
  TriagedMail,
} from "../types";
import {
  bool,
  getDb,
  num,
  parseJson,
  type Row,
  str,
  strOrNull,
} from "./client";

/**
 * Repository layer. Plain SQL over `node:sqlite`.
 *
 * The trace is written alongside the decision but stored separately, so the hot
 * triage query never touches it (PLAN.md §11).
 */

const b = (value: boolean): number => (value ? 1 : 0);

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export function ensureAccount(email: string, provider = "mock"): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO accounts (id, email, provider, created_at)
     VALUES ('default', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, provider = excluded.provider`,
  ).run(email, provider, new Date().toISOString());
}

export function getOwnerEmail(): string {
  const row = getDb()
    .prepare(`SELECT email FROM accounts WHERE id = 'default'`)
    .get() as Row | undefined;
  return row ? str(row.email) : "";
}

// ---------------------------------------------------------------------------
// Threads & messages
// ---------------------------------------------------------------------------

export function upsertThread(args: {
  gmailThreadId: string;
  subject: string;
  lastMessageAt: string;
}): string {
  const db = getDb();
  const id = `th_${args.gmailThreadId}`;
  db.prepare(
    `INSERT INTO threads (id, gmail_thread_id, subject, message_count, last_message_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(gmail_thread_id) DO UPDATE SET
       last_message_at = MAX(threads.last_message_at, excluded.last_message_at)`,
  ).run(id, args.gmailThreadId, args.subject, args.lastMessageAt);

  db.prepare(
    `UPDATE threads SET
       message_count = (SELECT COUNT(*) FROM messages WHERE gmail_thread_id = ?),
       subject = COALESCE((SELECT subject FROM messages WHERE gmail_thread_id = ? ORDER BY received_at ASC LIMIT 1), subject)
     WHERE gmail_thread_id = ?`,
  ).run(args.gmailThreadId, args.gmailThreadId, args.gmailThreadId);

  return id;
}

export function insertMessage(message: Message): void {
  getDb()
    .prepare(
      `INSERT INTO messages (
         id, gmail_message_id, gmail_thread_id, from_name, from_email,
         to_json, cc_json, subject, clean_body, snippet, received_at,
         label_ids_json, headers_json, has_attachments, attachment_names_json,
         is_from_me, content_hash, prior_user_replied, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(gmail_message_id) DO UPDATE SET
         clean_body = excluded.clean_body,
         snippet = excluded.snippet,
         label_ids_json = excluded.label_ids_json,
         prior_user_replied = excluded.prior_user_replied`,
    )
    .run(
      message.id,
      message.gmailMessageId,
      message.gmailThreadId,
      message.from.name ?? null,
      message.from.email,
      JSON.stringify(message.to),
      JSON.stringify(message.cc),
      message.subject,
      message.cleanBody,
      message.snippet,
      message.receivedAt,
      JSON.stringify(message.labelIds),
      JSON.stringify(message.headers),
      b(message.hasAttachments),
      JSON.stringify(message.attachmentNames),
      b(message.isFromMe),
      message.contentHash,
      b(message.priorUserReplied),
      new Date().toISOString(),
    );

  upsertThread({
    gmailThreadId: message.gmailThreadId,
    subject: message.subject,
    lastMessageAt: message.receivedAt,
  });
}

function rowToMessage(row: Row): Message {
  return {
    id: str(row.id),
    gmailMessageId: str(row.gmail_message_id),
    gmailThreadId: str(row.gmail_thread_id),
    from: {
      name: strOrNull(row.from_name) ?? undefined,
      email: str(row.from_email),
    },
    to: parseJson<Address[]>(row.to_json, []),
    cc: parseJson<Address[]>(row.cc_json, []),
    subject: str(row.subject),
    cleanBody: str(row.clean_body),
    snippet: str(row.snippet),
    receivedAt: str(row.received_at),
    labelIds: parseJson<string[]>(row.label_ids_json, []),
    headers: parseJson<Record<string, string>>(row.headers_json, {}),
    hasAttachments: bool(row.has_attachments),
    attachmentNames: parseJson<string[]>(row.attachment_names_json, []),
    isFromMe: bool(row.is_from_me),
    contentHash: str(row.content_hash),
    priorUserReplied: bool(row.prior_user_replied),
  };
}

export function getMessage(id: string): Message | null {
  const row = getDb()
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? rowToMessage(row) : null;
}

export function countThreadMessages(gmailThreadId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM messages WHERE gmail_thread_id = ?`)
    .get(gmailThreadId) as Row | undefined;
  return row ? num(row.c) : 0;
}

// ---------------------------------------------------------------------------
// Signal bundles
// ---------------------------------------------------------------------------

export function saveSignalBundle(bundle: SignalBundle): void {
  getDb()
    .prepare(
      `INSERT INTO signal_bundles (message_id, signals_json, base_score, computed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         signals_json = excluded.signals_json,
         base_score = excluded.base_score,
         computed_at = excluded.computed_at`,
    )
    .run(
      bundle.messageId,
      JSON.stringify(bundle.signals),
      bundle.baseScore,
      bundle.computedAt,
    );
}

export function getSignalBundle(messageId: string): SignalBundle | null {
  const row = getDb()
    .prepare(`SELECT * FROM signal_bundles WHERE message_id = ?`)
    .get(messageId) as Row | undefined;
  if (!row) return null;
  return {
    messageId: str(row.message_id),
    signals: parseJson(row.signals_json, []),
    baseScore: num(row.base_score),
    computedAt: str(row.computed_at),
  };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export function saveDecision(decision: Decision): void {
  const db = getDb();

  db.prepare(
    `INSERT INTO decisions (
       message_id, schema_version, persona_primary, persona_secondary_json,
       persona_confidence, suggest_new_persona_json, priority_band,
       priority_score, deadline, requires_reply, requires_action, tldr,
       asks_json, key_facts_json, sentiment, reading_time_seconds,
       entities_json, trust_verdict, is_spam, is_phishing, trust_signals_json,
       risk_score, warnings_json, is_noise, noise_category, summary_line,
       confidence_overall, needs_human_review, escalated_to_pro,
       is_inconsistent, engine, model_id, prompt_version, tokens_in,
       tokens_out, cost_usd, latency_ms, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       persona_primary = excluded.persona_primary,
       priority_band = excluded.priority_band,
       priority_score = excluded.priority_score,
       tldr = excluded.tldr,
       trust_verdict = excluded.trust_verdict,
       is_noise = excluded.is_noise,
       is_inconsistent = excluded.is_inconsistent,
       engine = excluded.engine,
       model_id = excluded.model_id,
       cost_usd = excluded.cost_usd,
       created_at = excluded.created_at`,
  ).run(
    decision.messageId,
    decision.schemaVersion,
    decision.persona.primary,
    JSON.stringify(decision.persona.secondary),
    decision.persona.confidence,
    decision.persona.suggestNewPersona
      ? JSON.stringify(decision.persona.suggestNewPersona)
      : null,
    decision.priorityBand,
    decision.priorityScore,
    decision.deadline,
    b(decision.requiresReply),
    b(decision.requiresAction),
    decision.intelligence.tldr,
    JSON.stringify(decision.intelligence.asks),
    JSON.stringify(decision.intelligence.keyFacts),
    decision.intelligence.sentiment,
    decision.intelligence.readingTimeSeconds,
    JSON.stringify(decision.intelligence.entities),
    decision.trust.verdict,
    b(decision.trust.isSpam),
    b(decision.trust.isPhishing),
    JSON.stringify(decision.trust.signals),
    decision.trust.riskScore,
    JSON.stringify(decision.trust.warnings),
    b(decision.noise.isNoise),
    decision.noise.category,
    decision.noise.summaryLine,
    decision.confidence.overall,
    b(decision.confidence.needsHumanReview),
    b(decision.escalatedToPro),
    b(decision.isInconsistent),
    decision.engine,
    decision.trace.model,
    decision.promptVersion,
    decision.tokensIn,
    decision.tokensOut,
    decision.costUsd,
    decision.latencyMs,
    decision.createdAt,
  );

  const t = decision.trace;
  db.prepare(
    `INSERT INTO decision_traces (
       message_id, deterministic_score, persona_bias, model_adjustment,
       final_score, band, evidence_json, adjustments_json,
       persona_bias_detail_json, model_id, prompt_version, cache_hit,
       arithmetic_ok, computed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       deterministic_score = excluded.deterministic_score,
       persona_bias = excluded.persona_bias,
       model_adjustment = excluded.model_adjustment,
       final_score = excluded.final_score,
       band = excluded.band,
       evidence_json = excluded.evidence_json,
       adjustments_json = excluded.adjustments_json,
       persona_bias_detail_json = excluded.persona_bias_detail_json,
       arithmetic_ok = excluded.arithmetic_ok,
       computed_at = excluded.computed_at`,
  ).run(
    decision.messageId,
    t.deterministicScore,
    t.personaBias,
    t.modelAdjustment,
    t.finalScore,
    t.band,
    JSON.stringify(t.evidence),
    JSON.stringify(t.adjustments),
    JSON.stringify(t.personaBiasDetail),
    t.model,
    t.promptVersion,
    b(t.cacheHit),
    b(t.arithmeticOk),
    t.computedAt,
  );
}

function rowToDecision(row: Row, trace: DecisionTrace): Decision {
  return {
    messageId: str(row.message_id),
    schemaVersion: num(row.schema_version),
    persona: {
      primary: str(row.persona_primary),
      secondary: parseJson<string[]>(row.persona_secondary_json, []),
      confidence: num(row.persona_confidence),
      suggestNewPersona: parseJson<{ name: string; reason: string } | null>(
        row.suggest_new_persona_json,
        null,
      ),
    },
    priority: {
      modelAdjustment: trace.modelAdjustment,
      adjustments: trace.adjustments,
    },
    deadline: strOrNull(row.deadline),
    requiresReply: bool(row.requires_reply),
    requiresAction: bool(row.requires_action),
    intelligence: {
      tldr: str(row.tldr),
      asks: parseJson(row.asks_json, []),
      keyFacts: parseJson(row.key_facts_json, []),
      sentiment: str(row.sentiment),
      readingTimeSeconds: num(row.reading_time_seconds),
      entities: parseJson(row.entities_json, {
        people: [],
        orgs: [],
        dates: [],
        money: [],
        links: [],
      }),
    },
    trust: {
      verdict: str(row.trust_verdict) as Decision["trust"]["verdict"],
      isSpam: bool(row.is_spam),
      isPhishing: bool(row.is_phishing),
      signals: parseJson<string[]>(row.trust_signals_json, []),
      riskScore: num(row.risk_score),
      warnings: parseJson<string[]>(row.warnings_json, []),
    },
    noise: {
      isNoise: bool(row.is_noise),
      category: strOrNull(row.noise_category) as Decision["noise"]["category"],
      summaryLine: strOrNull(row.summary_line),
    },
    confidence: {
      overall: num(row.confidence_overall),
      needsHumanReview: bool(row.needs_human_review),
    },
    priorityBand: str(row.priority_band) as PriorityBand,
    priorityScore: num(row.priority_score),
    trace,
    escalatedToPro: bool(row.escalated_to_pro),
    isInconsistent: bool(row.is_inconsistent),
    engine: str(row.engine) as Decision["engine"],
    promptVersion: str(row.prompt_version),
    tokensIn: num(row.tokens_in),
    tokensOut: num(row.tokens_out),
    costUsd: num(row.cost_usd),
    latencyMs: num(row.latency_ms),
    createdAt: str(row.created_at),
  };
}

function rowToTrace(row: Row): DecisionTrace {
  return {
    deterministicScore: num(row.deterministic_score),
    personaBias: num(row.persona_bias),
    modelAdjustment: num(row.model_adjustment),
    finalScore: num(row.final_score),
    band: str(row.band) as PriorityBand,
    evidence: parseJson(row.evidence_json, []),
    adjustments: parseJson(row.adjustments_json, []),
    personaBiasDetail: parseJson(row.persona_bias_detail_json, []),
    model: str(row.model_id),
    promptVersion: str(row.prompt_version),
    cacheHit: bool(row.cache_hit),
    arithmeticOk: bool(row.arithmetic_ok),
    computedAt: str(row.computed_at),
  };
}

// ---------------------------------------------------------------------------
// Triage queries
// ---------------------------------------------------------------------------

/**
 * Where a message sits in its lifecycle.
 *
 *   active   — in the queue
 *   archived — hidden, still stored, restorable
 *   trash    — deleted, still stored, either restorable or purgeable
 *
 * Both non-active states are *local tombstones*. Nothing here writes to Gmail:
 * the IMAP source is read-only by design, so "delete" means "stop showing me
 * this" rather than "destroy it in my mailbox". `deleted_at` is what stops a
 * re-sync from resurrecting a message you have trashed.
 */
export type MailState = "active" | "archived" | "trash";

export type MailFilter = {
  persona?: string;
  band?: PriorityBand;
  limit?: number;
  /** Include noise/digest-only mail. Defaults to true for archived and trash. */
  includeNoise?: boolean;
  /** Return only quarantined (suspicious/phishing) mail. */
  quarantineOnly?: boolean;
  state?: MailState;
};

function stateClause(state: MailState): string {
  switch (state) {
    case "archived":
      return "m.deleted_at IS NULL AND m.archived = 1";
    case "trash":
      return "m.deleted_at IS NOT NULL";
    default:
      return "m.deleted_at IS NULL AND m.archived = 0";
  }
}

export function listTriaged(filter: MailFilter = {}): TriagedMail[] {
  const db = getDb();
  const state = filter.state ?? "active";

  const rows = db
    .prepare(
      `SELECT m.*, d.persona_primary AS d_persona, d.priority_band AS d_band,
              d.priority_score AS d_score, d.is_noise AS d_noise,
              d.trust_verdict AS d_trust, d.needs_human_review AS d_review
       FROM messages m
       LEFT JOIN decisions d ON d.message_id = m.id
       WHERE m.is_from_me = 0 AND ${stateClause(state)}
       ORDER BY COALESCE(d.priority_score, -1) DESC, m.received_at DESC`,
    )
    .all() as Row[];

  let items: TriagedMail[] = rows.map((row) => {
    const message = rowToMessage(row);
    const threadCount = countThreadMessages(message.gmailThreadId);
    return { message, decision: null, threadCount };
  });

  if (items.length === 0) return [];

  // One query for all decisions + traces, then merge in JS.
  const ids = items.map((i) => i.message.id);
  const placeholders = ids.map(() => "?").join(",");

  const decisionRows = db
    .prepare(`SELECT * FROM decisions WHERE message_id IN (${placeholders})`)
    .all(...ids) as Row[];

  const traceRows = db
    .prepare(
      `SELECT * FROM decision_traces WHERE message_id IN (${placeholders})`,
    )
    .all(...ids) as Row[];

  const traceById = new Map(traceRows.map((r) => [str(r.message_id), rowToTrace(r)]));
  const decisionById = new Map<string, Decision>();

  for (const row of decisionRows) {
    const id = str(row.message_id);
    const trace = traceById.get(id);
    if (!trace) continue;
    decisionById.set(id, rowToDecision(row, trace));
  }

  items = items.map((item) => ({
    ...item,
    decision: decisionById.get(item.message.id) ?? null,
  }));

  // Filters that depend on the decision or thread count.
  // Archived and trash lanes are explicitly *everything you filed away*, so they
  // keep noise rather than hiding it the way the active queue does.
  const includeNoise = filter.includeNoise ?? state !== "active";
  if (!includeNoise) {
    items = items.filter((i) => !i.decision?.noise.isNoise);
  }
  if (filter.quarantineOnly) {
    items = items.filter((i) => {
      const v = i.decision?.trust.verdict;
      return v === "suspicious" || v === "phishing";
    });
  }
  if (filter.persona) {
    items = items.filter((i) => i.decision?.persona.primary === filter.persona);
  }
  if (filter.band) {
    items = items.filter((i) => i.decision?.priorityBand === filter.band);
  }

  return typeof filter.limit === "number"
    ? items.slice(0, filter.limit)
    : items;
}

export function getTriagedMail(messageId: string): TriagedMail | null {
  const message = getMessage(messageId);
  if (!message) return null;
  const db = getDb();
  const dRow = db
    .prepare(`SELECT * FROM decisions WHERE message_id = ?`)
    .get(messageId) as Row | undefined;
  const tRow = db
    .prepare(`SELECT * FROM decision_traces WHERE message_id = ?`)
    .get(messageId) as Row | undefined;

  return {
    message,
    decision: dRow && tRow ? rowToDecision(dRow, rowToTrace(tRow)) : null,
    threadCount: countThreadMessages(message.gmailThreadId),
  };
}

export function getThreadMessages(gmailThreadId: string): Message[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM messages WHERE gmail_thread_id = ? ORDER BY received_at ASC`,
    )
    .all(gmailThreadId) as Row[];
  return rows.map(rowToMessage);
}

/**
 * Lifecycle transitions.
 *
 * Archive and delete are mutually exclusive, and each clears the other's flag —
 * otherwise a message trashed from the archive would stay archived and reappear
 * in both lanes.
 *
 * None of these touch the remote mailbox. The IMAP source is read-only, so these
 * are local filing decisions; a re-sync will not resurrect them because
 * `deleted_at` and `archived` are checked by every listing query.
 */
export function setArchived(messageId: string, archived: boolean): void {
  getDb()
    .prepare(
      archived
        ? `UPDATE messages SET archived = 1, deleted_at = NULL WHERE id = ?`
        : `UPDATE messages SET archived = 0 WHERE id = ?`,
    )
    .run(messageId);
}

export function setDeleted(messageId: string, deleted: boolean): void {
  getDb()
    .prepare(
      deleted
        ? `UPDATE messages SET deleted_at = ?, archived = 0 WHERE id = ?`
        : `UPDATE messages SET deleted_at = NULL WHERE id = ?`,
    )
    .run(...(deleted ? [new Date().toISOString(), messageId] : [messageId]));
}

/** Permanently remove a message and everything derived from it. */
export function purgeMessage(messageId: string): void {
  const db = getDb();
  // Explicit deletes rather than relying on cascade: foreign_keys is a
  // per-connection pragma and the derived tables may predate it.
  db.prepare(`DELETE FROM decision_traces WHERE message_id = ?`).run(messageId);
  db.prepare(`DELETE FROM decisions WHERE message_id = ?`).run(messageId);
  db.prepare(`DELETE FROM signal_bundles WHERE message_id = ?`).run(messageId);
  db.prepare(`DELETE FROM messages WHERE id = ?`).run(messageId);
}

/** Empty the trash for real. Returns how many messages were removed. */
export function purgeAllDeleted(): number {
  const rows = getDb()
    .prepare(`SELECT id FROM messages WHERE deleted_at IS NOT NULL`)
    .all() as Row[];
  for (const row of rows) purgeMessage(str(row.id));
  return rows.length;
}

export function getMailStateCounts(): {
  active: number;
  archived: number;
  trash: number;
} {
  const row = getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN deleted_at IS NULL AND archived = 0 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN deleted_at IS NULL AND archived = 1 THEN 1 ELSE 0 END) AS archived,
         SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trash
       FROM messages WHERE is_from_me = 0`,
    )
    .get() as Row | undefined;
  return {
    active: row ? num(row.active) : 0,
    archived: row ? num(row.archived) : 0,
    trash: row ? num(row.trash) : 0,
  };
}

export function setBandOverride(messageId: string, band: PriorityBand): void {
  getDb()
    .prepare(`UPDATE messages SET user_band_override = ? WHERE id = ?`)
    .run(band, messageId);
}

// ---------------------------------------------------------------------------
// Feedback & events
// ---------------------------------------------------------------------------

export function saveFeedback(args: {
  messageId: string;
  field: string;
  aiValue: string | null;
  userValue: string | null;
  traceSnapshot?: unknown;
}): void {
  getDb()
    .prepare(
      `INSERT INTO feedback (message_id, field, ai_value, user_value, trace_snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.messageId,
      args.field,
      args.aiValue,
      args.userValue,
      args.traceSnapshot ? JSON.stringify(args.traceSnapshot) : null,
      new Date().toISOString(),
    );
}

export function recordEvent(
  level: "info" | "warn" | "error",
  message: string,
  messageId?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO pipeline_events (message_id, level, message, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(messageId ?? null, level, message, new Date().toISOString());
}

export function listEvents(limit = 50): {
  id: number;
  level: string;
  message: string;
  messageId: string | null;
  createdAt: string;
}[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM pipeline_events ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map((r) => ({
    id: num(r.id),
    level: str(r.level),
    message: str(r.message),
    messageId: strOrNull(r.message_id),
    createdAt: str(r.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Stats & digest
// ---------------------------------------------------------------------------

export type Stats = {
  total: number;
  byBand: Record<PriorityBand, number>;
  byPersona: { persona: string; count: number; avgScore: number }[];
  byEngine: { engine: string; count: number }[];
  totalCostUsd: number;
  avgLatencyMs: number;
  cacheHitRate: number;
  inconsistent: number;
  needsReview: number;
  quarantined: number;
  noise: number;
};

export function getStats(): Stats {
  const db = getDb();

  const bandRows = db
    .prepare(
      `SELECT priority_band AS band, COUNT(*) AS c FROM decisions GROUP BY priority_band`,
    )
    .all() as Row[];

  const byBand: Record<PriorityBand, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const r of bandRows) {
    const band = str(r.band) as PriorityBand;
    if (band in byBand) byBand[band] = num(r.c);
  }

  const personaRows = db
    .prepare(
      `SELECT persona_primary AS persona, COUNT(*) AS c, AVG(priority_score) AS avg
       FROM decisions GROUP BY persona_primary ORDER BY c DESC`,
    )
    .all() as Row[];

  const engineRows = db
    .prepare(
      `SELECT engine, COUNT(*) AS c FROM decisions GROUP BY engine`,
    )
    .all() as Row[];

  const agg = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(cost_usd),0) AS cost,
              COALESCE(AVG(latency_ms),0) AS latency,
              COALESCE(SUM(is_inconsistent),0) AS inconsistent,
              COALESCE(SUM(needs_human_review),0) AS review,
              COALESCE(SUM(is_phishing),0) AS phishing,
              COALESCE(SUM(is_noise),0) AS noise
       FROM decisions`,
    )
    .get() as Row | undefined;

  const traceAgg = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(cache_hit),0) AS hits FROM decision_traces`,
    )
    .get() as Row | undefined;

  const traceTotal = traceAgg ? num(traceAgg.total) : 0;
  const traceHits = traceAgg ? num(traceAgg.hits) : 0;

  return {
    total: agg ? num(agg.total) : 0,
    byBand,
    byPersona: personaRows.map((r) => ({
      persona: str(r.persona),
      count: num(r.c),
      avgScore: Math.round(num(r.avg)),
    })),
    byEngine: engineRows.map((r) => ({
      engine: str(r.engine),
      count: num(r.c),
    })),
    totalCostUsd: agg ? num(agg.cost) : 0,
    avgLatencyMs: agg ? Math.round(num(agg.latency)) : 0,
    cacheHitRate: traceTotal > 0 ? traceHits / traceTotal : 0,
    inconsistent: agg ? num(agg.inconsistent) : 0,
    needsReview: agg ? num(agg.review) : 0,
    quarantined: agg ? num(agg.phishing) : 0,
    noise: agg ? num(agg.noise) : 0,
  };
}

export function listNoise(limit = 100): TriagedMail[] {
  const rows = getDb()
    .prepare(
      `SELECT m.* FROM messages m
       JOIN decisions d ON d.message_id = m.id
       WHERE d.is_noise = 1 AND m.archived = 0 AND m.deleted_at IS NULL
         AND m.is_from_me = 0
       ORDER BY m.received_at DESC LIMIT ?`,
    )
    .all(limit) as Row[];

  return rows.map((row) => {
    const message = rowToMessage(row);
    const triaged = getTriagedMail(message.id);
    return (
      triaged ?? {
        message,
        decision: null,
        threadCount: countThreadMessages(message.gmailThreadId),
      }
    );
  });
}

export function buildDigest(date: string): DailyDigest {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.id, m.subject, m.from_name, m.from_email, m.received_at,
              d.summary_line, d.noise_category, d.priority_score
       FROM messages m
       JOIN decisions d ON d.message_id = m.id
       WHERE d.is_noise = 1 AND substr(m.received_at, 1, 10) = ?
       ORDER BY m.received_at DESC`,
    )
    .all(date) as Row[];

  const actionableRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM messages m
       JOIN decisions d ON d.message_id = m.id
       WHERE d.is_noise = 0 AND d.priority_score >= 70
         AND substr(m.received_at, 1, 10) = ?`,
    )
    .get(date) as Row | undefined;

  const rolledUp = rows.map((r) => ({
    messageId: str(r.id),
    subject: str(r.subject),
    from: str(r.from_name) || str(r.from_email),
    line:
      strOrNull(r.summary_line) ??
      `${str(r.from_email)}: ${str(r.subject)}`,
  }));

  const categoryCounts = new Map<string, number>();
  for (const r of rows) {
    const cat = strOrNull(r.noise_category) ?? "other";
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
  }

  const breakdown = Array.from(categoryCounts.entries())
    .map(([cat, n]) => `${n} ${cat}${n === 1 ? "" : "s"}`)
    .join(", ");

  const actionable = actionableRow ? num(actionableRow.c) : 0;

  return {
    date,
    totalNoise: rows.length,
    totalActionable: actionable,
    rolledUp,
    summary:
      rows.length === 0
        ? "Nothing was filtered into the digest for this day."
        : `${rows.length} message${rows.length === 1 ? "" : "s"} filtered out${
            breakdown ? ` (${breakdown})` : ""
          }. ${actionable} high-priority message${
            actionable === 1 ? "" : "s"
          } still needed you.`,
  };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export function clearAll(): void {
  const db = getDb();
  for (const table of [
    "decision_traces",
    "decisions",
    "signal_bundles",
    "feedback",
    "pipeline_events",
    "digests",
    "messages",
    "threads",
    "accounts",
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
}

export function countMessages(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM messages`)
    .get() as Row | undefined;
  return row ? num(row.c) : 0;
}

/**
 * Which messages already have a decision, keyed by id.
 *
 * Used for idempotent re-sync: if a message's content hash, prompt version and
 * producing *engine* are all unchanged, re-running would cost money to produce
 * the same answer.
 *
 * The engine is part of the key on purpose. Without it, fixing a broken API key
 * and pressing Sync would skip every message — the stored fallback decisions
 * would look "already analyzed" and the model would never see the mail.
 */
export function getAnalysisState(): Map<
  string,
  { contentHash: string; promptVersion: string; engine: string }
> {
  const rows = getDb()
    .prepare(
      `SELECT m.id AS id, m.content_hash AS content_hash,
              d.prompt_version AS prompt_version, d.engine AS engine
       FROM messages m
       JOIN decisions d ON d.message_id = m.id`,
    )
    .all() as Row[];

  const map = new Map<
    string,
    { contentHash: string; promptVersion: string; engine: string }
  >();
  for (const row of rows) {
    map.set(str(row.id), {
      contentHash: str(row.content_hash),
      promptVersion: str(row.prompt_version),
      engine: str(row.engine),
    });
  }
  return map;
}
