/**
 * SQLite schema.
 *
 * Deliberately plain SQL over `node:sqlite` rather than an ORM: the plan called
 * for Postgres/Prisma, but the reduced scope (REVIEW.md) drops that weight. A
 * single-file database means the app runs with zero external services, which is
 * what makes the decision pipeline and eval harness actually runnable.
 *
 * `decision_traces` is a separate, append-only table (PLAN.md §11): it keeps the
 * fat JSON blob out of the hot triage query, and it is never mutated, so the
 * answer to "why was this P0 last Tuesday?" survives prompt changes.
 */

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id                      TEXT PRIMARY KEY,
  email                   TEXT NOT NULL,
  provider                TEXT NOT NULL DEFAULT 'mock',
  history_id              TEXT,
  sync_state              TEXT,
  encrypted_refresh_token TEXT,
  created_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id                TEXT PRIMARY KEY,
  gmail_thread_id   TEXT NOT NULL UNIQUE,
  subject           TEXT NOT NULL,
  message_count     INTEGER NOT NULL DEFAULT 0,
  last_message_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id                   TEXT PRIMARY KEY,
  gmail_message_id     TEXT NOT NULL UNIQUE,
  gmail_thread_id      TEXT NOT NULL,
  from_name            TEXT,
  from_email           TEXT NOT NULL,
  to_json              TEXT NOT NULL,
  cc_json              TEXT NOT NULL,
  subject              TEXT NOT NULL,
  clean_body           TEXT NOT NULL,
  snippet              TEXT NOT NULL,
  received_at          TEXT NOT NULL,
  label_ids_json       TEXT NOT NULL,
  headers_json         TEXT NOT NULL,
  has_attachments      INTEGER NOT NULL DEFAULT 0,
  attachment_names_json TEXT NOT NULL DEFAULT '[]',
  is_from_me           INTEGER NOT NULL DEFAULT 0,
  content_hash         TEXT NOT NULL,
  prior_user_replied   INTEGER NOT NULL DEFAULT 0,
  archived             INTEGER NOT NULL DEFAULT 0,
  snoozed_until        TEXT,
  user_band_override   TEXT,
  deleted_at           TEXT,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread   ON messages(gmail_thread_id, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_hash     ON messages(content_hash);

CREATE TABLE IF NOT EXISTS signal_bundles (
  message_id    TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  signals_json  TEXT NOT NULL,
  base_score    REAL NOT NULL,
  computed_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  message_id             TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  schema_version         INTEGER NOT NULL,
  persona_primary        TEXT NOT NULL,
  persona_secondary_json TEXT NOT NULL,
  persona_confidence     REAL NOT NULL,
  suggest_new_persona_json TEXT,
  priority_band          TEXT NOT NULL,
  priority_score         REAL NOT NULL,
  deadline               TEXT,
  requires_reply         INTEGER NOT NULL,
  requires_action        INTEGER NOT NULL,
  tldr                   TEXT NOT NULL,
  asks_json              TEXT NOT NULL,
  key_facts_json         TEXT NOT NULL,
  sentiment              TEXT NOT NULL,
  reading_time_seconds   INTEGER NOT NULL,
  entities_json          TEXT NOT NULL,
  trust_verdict          TEXT NOT NULL,
  is_spam                INTEGER NOT NULL,
  is_phishing            INTEGER NOT NULL,
  trust_signals_json     TEXT NOT NULL,
  risk_score             REAL NOT NULL,
  warnings_json          TEXT NOT NULL,
  is_noise               INTEGER NOT NULL,
  noise_category         TEXT,
  summary_line           TEXT,
  confidence_overall     REAL NOT NULL,
  needs_human_review     INTEGER NOT NULL,
  escalated_to_pro       INTEGER NOT NULL,
  is_inconsistent        INTEGER NOT NULL,
  engine                 TEXT NOT NULL,
  model_id               TEXT NOT NULL,
  prompt_version         TEXT NOT NULL,
  tokens_in              INTEGER NOT NULL DEFAULT 0,
  tokens_out             INTEGER NOT NULL DEFAULT 0,
  cost_usd               REAL NOT NULL DEFAULT 0,
  latency_ms             INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_band    ON decisions(priority_band, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_persona ON decisions(persona_primary, priority_band);

CREATE TABLE IF NOT EXISTS decision_traces (
  message_id                TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  deterministic_score       REAL NOT NULL,
  persona_bias              REAL NOT NULL,
  model_adjustment          REAL NOT NULL,
  final_score               REAL NOT NULL,
  band                      TEXT NOT NULL,
  evidence_json             TEXT NOT NULL,
  adjustments_json          TEXT NOT NULL,
  persona_bias_detail_json  TEXT NOT NULL,
  model_id                  TEXT NOT NULL,
  prompt_version            TEXT NOT NULL,
  cache_hit                 INTEGER NOT NULL,
  arithmetic_ok             INTEGER NOT NULL,
  computed_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id          TEXT NOT NULL,
  field               TEXT NOT NULL,
  ai_value            TEXT,
  user_value          TEXT,
  trace_snapshot_json TEXT,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_message ON feedback(message_id);

CREATE TABLE IF NOT EXISTS digests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT NOT NULL UNIQUE,
  digest_json   TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  generated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT,
  level       TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
`;
