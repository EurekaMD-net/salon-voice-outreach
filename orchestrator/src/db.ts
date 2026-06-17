import Database from "better-sqlite3";
import { SCHEMA } from "./schema.js";

/** Apply the schema (idempotent). Safe on every boot. */
export function migrate(db: Database.Database): void {
  db.exec(SCHEMA);
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
