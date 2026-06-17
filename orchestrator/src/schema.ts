/**
 * Canonical orchestrator schema (SQLite). This is the L4 capture spine — built
 * FIRST (SPEC §11), before any dial. `call_attempt.raw` stores the full webhook
 * payload verbatim so Stage 2 can mine data we don't yet know we'll want.
 *
 * SQLite notes: ids are app-generated UUIDs (TEXT); booleans are 0/1; JSON is
 * TEXT. All idempotent (`IF NOT EXISTS`) so migrate() is safe to run on every boot.
 *
 * CANONICAL TIMESTAMP FORMAT (QA M2 — decided 2026-06-17): every timestamp column
 * is the SQLite `datetime('now')` form — "YYYY-MM-DD HH:MM:SS", UTC, space-separated,
 * no `T`/`Z`. ALL writes (incl. the increment-4 retry-write of `next_eligible_at`)
 * MUST use SQL `datetime(...)` (e.g. `datetime('now', '+24 hours')`), NEVER JS
 * `Date.toISOString()` — mixing the two breaks lexical `ORDER BY` / `<=` comparison
 * on these TEXT columns (space 0x20 sorts before 'T' 0x54).
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS prospect (
  id               TEXT PRIMARY KEY,
  name             TEXT,
  colonia          TEXT,
  phone_e164       TEXT UNIQUE NOT NULL,
  ig_handle        TEXT,
  source           TEXT NOT NULL DEFAULT 'denue-iztapalapa-2026-06',
  state            TEXT NOT NULL DEFAULT 'queued'
                     CHECK (state IN ('queued','dialing','no_answer','voicemail',
                       'connected','qualified','declined','dnc','optin_sent',
                       'inbound_received','won','lost','exhausted','invalid')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  TEXT,
  next_eligible_at TEXT NOT NULL DEFAULT (datetime('now')),
  crm_lead_id      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_prospect_state_eligible
  ON prospect(state, next_eligible_at);

CREATE TABLE IF NOT EXISTS call_attempt (
  id               TEXT PRIMARY KEY,
  prospect_id      TEXT NOT NULL REFERENCES prospect(id),
  campaign_id      TEXT NOT NULL,
  pipesong_call_id TEXT,
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at         TEXT,
  duration_s       INTEGER,
  disposition      TEXT
                     CHECK (disposition IS NULL OR disposition IN
                       ('no_answer','voicemail','connected','qualified',
                        'declined','dnc','failed')),
  optin_sent       INTEGER NOT NULL DEFAULT 0 CHECK (optin_sent IN (0,1)),
  transcript_ref   TEXT,
  recording_ref    TEXT,
  raw              TEXT
);
CREATE INDEX IF NOT EXISTS ix_call_prospect
  ON call_attempt(prospect_id, started_at DESC);

CREATE TABLE IF NOT EXISTS dnc (
  phone_e164  TEXT PRIMARY KEY,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'paused'
                CHECK (status IN ('paused','active','stopped')),
  window_cfg  TEXT NOT NULL,
  pacing_cfg  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
