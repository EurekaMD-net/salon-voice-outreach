import Database from "better-sqlite3";
import { SCHEMA } from "./schema.js";

/**
 * Apply the schema. Idempotent — safe on every boot.
 *
 * `CREATE TABLE IF NOT EXISTS` is a NO-OP on a table that already exists, so it
 * does NOT add a column introduced after that table was first created. Column
 * additions need an explicit, guarded `ALTER TABLE` that runs BEFORE `db.exec(SCHEMA)`
 * — because SCHEMA builds `ix_call_crm_unsynced` OVER `crm_synced_at`, which would
 * throw `no such column` on a pre-inc-3 DB. Widen the list as later columns land.
 */
export function migrate(db: Database.Database): void {
  addColumnIfMissing(db, "call_attempt", "crm_synced_at", "TEXT");
  db.exec(SCHEMA);
}

/**
 * Add `<table>.<col> <type>` only if the table already exists and lacks the column.
 * (`table`/`col`/`type` are internal constants, never user input.) No-op on a fresh
 * DB — the table doesn't exist yet, so the CREATE in SCHEMA will include the column.
 */
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  col: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

/**
 * Open the orchestrator DB. Pass ":memory:" in tests. WAL for concurrent
 * read/write; foreign keys enforced.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export type DB = Database.Database;
