import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema";

/**
 * Single-file SQLite via Node's built-in driver — no native build, no server.
 *
 * The handle is cached on `globalThis` because Next.js dev re-evaluates modules
 * on hot reload; without the cache every edit would open another handle to the
 * same file.
 *
 * That cache is also a hazard, which is what `SCHEMA_VERSION` exists to defuse:
 * a hot reload can swap in new SQL while the *old* connection — opened against a
 * pre-migration schema — is still sitting on `globalThis`. Migrations therefore
 * have to be re-checked on access, not only when the handle is first created.
 */

/**
 * Bump this whenever `COLUMN_MIGRATIONS` gains an entry.
 *
 * Without it, this sequence breaks the app:
 *   1. dev server starts, opens the database (column does not exist yet)
 *   2. code gains a migration + a query that uses the new column
 *   3. hot reload picks up the new query, but `getDb()` returns the cached
 *      handle and never re-runs migrations
 *   4. every request dies with `no such column`
 */
const SCHEMA_VERSION = 2;

const globalForDb = globalThis as unknown as {
  __androDb?: DatabaseSync;
  __androSchemaVersion?: number;
};

export function dbFilePath(): string {
  // `||` not `??`: an empty ANDRO_DB_DIR= (as shipped in .env.local) is a
  // defined-but-empty string, and `??` would resolve the path to the repo root.
  const dir =
    process.env.ANDRO_DB_DIR?.trim() || path.join(process.cwd(), ".data");
  return path.join(dir, "andro.db");
}

/**
 * Additive migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
 * new column never reaches an existing database. These run on every boot and are
 * idempotent: each column is added only if `PRAGMA table_info` does not list it.
 *
 * Additive only, by design — nothing here rewrites a table or moves data, so
 * applying them to a database full of real mail cannot lose anything.
 */
const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  {
    table: "messages",
    column: "archived",
    ddl: "ALTER TABLE messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "messages",
    column: "snoozed_until",
    ddl: "ALTER TABLE messages ADD COLUMN snoozed_until TEXT",
  },
  {
    table: "messages",
    column: "user_band_override",
    ddl: "ALTER TABLE messages ADD COLUMN user_band_override TEXT",
  },
  {
    table: "messages",
    column: "deleted_at",
    ddl: "ALTER TABLE messages ADD COLUMN deleted_at TEXT",
  },
];

function applyMigrations(db: DatabaseSync): void {
  for (const migration of COLUMN_MIGRATIONS) {
    const columns = db
      .prepare(`PRAGMA table_info(${migration.table})`)
      .all() as Row[];
    const existing = new Set(columns.map((c) => String(c.name)));
    if (!existing.has(migration.column)) {
      db.exec(migration.ddl);
    }
  }
}

function createDb(): DatabaseSync {
  const file = dbFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

export function getDb(): DatabaseSync {
  if (!globalForDb.__androDb) {
    const db = createDb();
    globalForDb.__androDb = db;
    globalForDb.__androSchemaVersion = SCHEMA_VERSION;
    return db;
  }

  // The cached handle may predate the current code. Re-apply migrations rather
  // than serving queries against a stale schema. `applyMigrations` is
  // idempotent, so this is a couple of PRAGMAs and no writes when up to date.
  if (globalForDb.__androSchemaVersion !== SCHEMA_VERSION) {
    applyMigrations(globalForDb.__androDb);
    globalForDb.__androSchemaVersion = SCHEMA_VERSION;
  }

  return globalForDb.__androDb;
}

/** Current schema version, surfaced by /api/health for diagnosis. */
export function schemaVersion(): number {
  return SCHEMA_VERSION;
}

export type Row = Record<string, unknown>;

export function bool(value: unknown): boolean {
  return value === 1 || value === true;
}

export function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
