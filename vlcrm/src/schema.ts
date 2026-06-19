/**
 * vlcrm schema (SQLite) — the pipeline of record + attribution spine.
 *
 * vlcrm is CHANNEL-AGNOSTIC: it knows nothing about pipesong, Telnyx, WhatsApp or
 * salons. It ingests normalized `LeadEvent`s (see lead-event.ts) and maintains the
 * business state. The generic spine is these four tables; vertical specifics
 * (SCIAN, colonia, IG) live in `account.attributes` (JSON TEXT), never columns.
 *
 * Four tables:
 *   account        — the business. Canonical identity, pipeline stage, provenance
 *                    (incl. structured REFERRAL: referred_by_*), compliance.
 *   contact        — person(s) at the account (≥1; usually 1).
 *   interaction    — append-only touch log across every channel. Current state is
 *                    DERIVED from this. cost_cents lives here → CPQL = SUM(cost) /
 *                    qualified_count, groupable by channel.
 *   qualification  — the structured verdict that makes a lead worth a close.
 *
 * SQLite notes: ids are app-generated UUIDs (TEXT); booleans are 0/1; JSON is TEXT.
 * All idempotent (`IF NOT EXISTS`) so migrate() is safe on every boot. Tables are
 * declared parent-before-child so REFERENCES resolve under `foreign_keys = ON`.
 *
 * CANONICAL TIMESTAMP FORMAT (same rule as the orchestrator, QA M2): every timestamp
 * column is the SQLite `datetime('now')` form — "YYYY-MM-DD HH:MM:SS", UTC, space-
 * separated, no `T`/`Z`. ALL writes MUST use SQL `datetime(...)`, NEVER JS
 * `Date.toISOString()` — mixing breaks lexical ORDER BY / `<=` on these TEXT columns
 * (space 0x20 sorts before 'T' 0x54).
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS account (
  id                      TEXT PRIMARY KEY,
  -- canonical dedup key: DENUE id, normalized E.164 phone, or "manual:<uuid>".
  account_key             TEXT UNIQUE NOT NULL,
  name                    TEXT,
  pipeline_stage          TEXT NOT NULL DEFAULT 'new'
                            CHECK (pipeline_stage IN
                              ('new','contacted','qualified','handed_off',
                               'engaged_inbound','won','lost')),
  -- acquisition channel the account first entered through (set-once provenance).
  source                  TEXT NOT NULL DEFAULT 'other'
                            CHECK (source IN
                              ('denue','sales_phone','web','referral','import','other')),
  -- structured REFERRAL provenance (orthogonal to source; set-once on creation).
  -- referrer is EITHER a known account (FK) OR free text (name/phone) when not in CRM.
  referred_by_account_id  TEXT REFERENCES account(id) ON DELETE SET NULL,
  referred_by_name        TEXT,
  referred_by_phone       TEXT,
  dnc                     INTEGER NOT NULL DEFAULT 0 CHECK (dnc IN (0,1)),
  consent_at              TEXT,
  attributes              TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_account_stage ON account(pipeline_stage);
CREATE INDEX IF NOT EXISTS ix_account_referrer ON account(referred_by_account_id);

CREATE TABLE IF NOT EXISTS contact (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name        TEXT,
  role        TEXT,
  phone_e164  TEXT,
  email       TEXT,
  ig_handle   TEXT,
  whatsapp_optin INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_optin IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- one contact row per (account, phone). NULL phones are distinct in SQLite UNIQUE,
  -- so anonymous contacts may repeat — acceptable for a manual path.
  UNIQUE (account_id, phone_e164)
);
CREATE INDEX IF NOT EXISTS ix_contact_account ON contact(account_id);

CREATE TABLE IF NOT EXISTS interaction (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  contact_id  TEXT REFERENCES contact(id) ON DELETE SET NULL,
  channel     TEXT NOT NULL
                CHECK (channel IN ('voice','sms','whatsapp','sales_phone','other')),
  direction   TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  -- free TEXT (not CHECK) so new event types don't require a migration; the app
  -- layer validates the known set. e.g. manual_intake|call|optin_sent|inbound|won|lost.
  type        TEXT NOT NULL,
  outcome     TEXT,
  cost_cents  INTEGER NOT NULL DEFAULT 0,
  ref_id      TEXT,
  payload     TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_interaction_account
  ON interaction(account_id, occurred_at DESC);
-- Exactly-once delivery key: a producer's refId ingests AT MOST once (the orchestrator
-- outbox is at-least-once and re-delivers on a crash-window). Partial so the many
-- ref_id-less rows (sales-phone intake, etc.) are exempt — NULLs are not unique.
CREATE UNIQUE INDEX IF NOT EXISTS ux_interaction_ref
  ON interaction(ref_id) WHERE ref_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS qualification (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  interested            INTEGER CHECK (interested IS NULL OR interested IN (0,1)),
  fit                   TEXT,
  objection             TEXT,
  callback_window       TEXT,
  score                 INTEGER,
  source_interaction_id TEXT REFERENCES interaction(id) ON DELETE SET NULL,
  captured_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_qual_account
  ON qualification(account_id, captured_at DESC);
`;
