# vlcrm

Very-light CRM — the **pipeline of record + channel attribution** for the
voice-outreach funnel. Hono + better-sqlite3, ESM, strict TS, heavy tests.

It answers three questions at any moment: _who have we touched, what state are
they in, and what did each channel cost to produce a qualified lead (CPQL)._
It is **channel-agnostic** — it knows nothing about pipesong, Telnyx, WhatsApp or
salons. Every channel emits one normalized **`LeadEvent`**; vlcrm couples to that
and nothing else. Adding a channel = emitting `LeadEvent`s, never a vlcrm change.

## Data model (4 tables)

- **account** — the business. Canonical `account_key` (dedup), `pipeline_stage`
  (forward-only: `new → contacted → qualified → handed_off → engaged_inbound →
won|lost`), **set-once provenance** (`source` + structured referral
  `referred_by_{account_id|name|phone}`), compliance (`dnc`, `consent_at`), and a
  JSON `attributes` bag for vertical specifics (SCIAN, colonia, IG).
- **contact** — person(s) at the account; deduped by `(account_id, phone)`.
- **interaction** — append-only touch log across every channel. `cost_cents` lives
  here, so **CPQL = SUM(cost) / qualified_count**, groupable by channel.
- **qualification** — the structured verdict (interested, fit, objection, score)
  that makes a lead worth a close.

## The `LeadEvent` ingest port

```ts
interface LeadEvent {
  accountKey: string; // canonical identity (upsert/dedup)
  channel: "voice" | "sms" | "whatsapp" | "sales_phone" | "other";
  direction: "inbound" | "outbound";
  type: string; // manual_intake|call|optin_sent|inbound|qualified|won|lost|...
  source?: AccountSource; // applied only when the account is first created
  name?: string;
  contact?: { name?; role?; phone?; email?; ig? };
  referredBy?: { accountKey?; name?; phone? }; // FK if known account, else free text
  outcome?: string;
  costCents?: number;
  refId?: string;
  payload?: unknown;
  qualification?: { interested?; fit?; objection?; callbackWindow?; score? };
  occurredAt?: string; // SQLite datetime() form; defaults to now
}
```

`validateLeadEvent()` fails **closed**: it throws on a missing/invalid required
field or a bad enum — it never silently coerces. `ingestLeadEvent()` runs in one
transaction: upsert account (provenance is **set-once**, never rewritten), dedup
the contact, append the interaction, optionally record a qualification, and
advance the stage **forward-only** (terminal-safe).

**Referrer rule:** EITHER an FK to a known account (`referredBy.accountKey`
resolves) OR free text (`name`/`phone`) — never both. The FK wins when it resolves.

## HTTP routes

| Method | Path             | Purpose                                                                           |
| ------ | ---------------- | --------------------------------------------------------------------------------- |
| GET    | `/healthz`       | liveness                                                                          |
| POST   | `/events`        | the agnostic port — ingest a raw `LeadEvent` (orchestrator, closer, web)          |
| POST   | `/leads/intake`  | operator **sales-phone manual intake** with a `referredBy*` field                 |
| GET    | `/accounts/:key` | read an account + interactions + latest qualification                             |
| GET    | `/metrics/cpql`  | **CPQL rollup** — cost-per-qualified-lead + cost-by-channel + qualified-by-source |

All mutating routes **and** the `/accounts` PII read **and** `/metrics` (business-
sensitive aggregates) sit behind an optional bearer guard (`AppOptions.apiKey`,
constant-time compare). A present-but-blank/short key throws at construction — the
service never boots open by misconfiguration. `/healthz` stays open.

**CPQL** = total interaction spend ÷ distinct accounts with an explicit
`interested=1` verdict (the qualification table, _not_ the coarse pipeline stage —
so a no-answer that advanced to "contacted" never inflates the denominator).
`cpqlCents` is `null` when there are no qualified leads.

## Run

```bash
npm install
npm run typecheck      # tsc --noEmit
npx vitest run test/   # 56 tests
```

> Status: Stage 1 increment 1. No server entrypoint / deploy yet (no listener;
> `createApp(db)` is the unit, tested via `app.request()`). Next: the orchestrator
> `LeadEvent` emitter + a CPQL rollup query.
