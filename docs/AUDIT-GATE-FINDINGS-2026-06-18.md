# audit-gate first-run findings — 2026-06-18

The `workflows/audit-gate.mjs` multi-lens gate (5 lenses → dedup → adversarial refute)
was smoke-tested against the CRM-loop increment (`c25a9e2..45fcd72`). It ran clean
(13 agents, all 3 phases), **confirmed 7 findings, dropped 1 as a false positive**.
Verdict: `review` (no Critical). All are **latent** — the service is undeployed and
`data/` is gitignored, so fresh deploys are unaffected; each bites on deploy or growth.

This is a hardening backlog, not a fire. Notably, several of these were **missed by the
original per-increment qa-auditor passes** — the value the fan-out + refute pass added.

> **RESOLVED 2026-06-18:** all 6 confirmed loop findings (#1–#6) FIXED, tested, and
> qa-gated (PASS) in the same session — orchestrator 97 tests, vlcrm 70 = **167**. The
> gate's own finding #7 (fail-open verify) was fixed in `0e82b83`. The table below is the
> historical record of what the first gate run found.

## Confirmed — hardening backlog

| #   | Sev  | File                                   | Defect                                                                                                                                                                                                                                                                         | Fix                                                                                                                                                                                        |
| --- | ---- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Warn | `orchestrator/src/schema.ts` 37-61     | `crm_synced_at` added via `CREATE TABLE IF NOT EXISTS` with **no `ALTER TABLE`** → `migrate()` **crashes at boot** (`no such column`) on any DB created by inc 1/2. Empirically reproduced. The header comment "idempotent, safe on every boot" is **false** for a column add. | In `migrate()`: `PRAGMA table_info(call_attempt)` → if `crm_synced_at` absent, `ALTER TABLE … ADD COLUMN crm_synced_at TEXT` **before** the `ix_call_crm_unsynced` index. Fix the comment. |
| 2   | Warn | `vlcrm/src/app.ts` 23-35               | `bearerOk` is **not** constant-time despite the comment: early `length !==` return + `charCodeAt` loop leak timing/length.                                                                                                                                                     | Use `crypto.timingSafeEqual` over fixed-size SHA-256 digests (no length branch). Fix the comment.                                                                                          |
| 3   | Warn | `orchestrator/src/crm-sync.ts` 52-53   | Poison-pill guard `<> ''` is **narrower** than the consumer's `.trim() === ''` reject — a whitespace-only phone (`' '`) passes the guard, 400s at vlcrm, becomes the permanent poison-pill the W1 guard claims to kill.                                                        | `AND TRIM(p.phone_e164) <> ''` (or trim in the SELECT and emit the trimmed value so guard = wire = validator).                                                                             |
| 4   | Warn | `orchestrator/src/crm-event.ts` 61-63  | `dnc` disposition maps to `type:'call'` and **advances the account FORWARD** to `contacted` at vlcrm with **no DNC flag** — the LeadEvent contract has no `dnc`/`suppress` field; `ingest` never sets `account.dnc`. Compliance gap for a ban-averse venture.                  | Add `dnc?: boolean` to LeadEvent; `buildCrmEvent` sets it on `dnc`; route `dnc` to a non-advancing type; `ingest` sets `account.dnc=1` set-once.                                           |
| 5   | Warn | `vlcrm/test/cpql.test.ts`              | CPQL **double-counts cost** under the system's own at-least-once delivery (re-emit on crash-window → new `interaction` row; `ref_id` not UNIQUE). No regression test pins the documented caveat. Reproduced (cost 2×).                                                         | Add `UNIQUE(ref_id) WHERE ref_id IS NOT NULL` on `interaction` + `INSERT OR IGNORE` in `ingest` (the queued **exactly-once refId dedup**), and a test asserting a 2nd emit is a no-op.     |
| 6   | Warn | `orchestrator/test/crm-client.test.ts` | **No automated cross-service contract test**: `buildCrmEvent` output is never run through vlcrm's `validateLeadEvent`. The "#1 contract check" was a manual pass; the seam fake validates nothing. A field rename / enum tighten 400s in prod while both suites stay green.    | Contract test: `validateLeadEvent(buildCrmEvent(row, cfg))` does not throw for **every** Disposition, and round-tripped fields match.                                                      |
| 7   | Info | `workflows/audit-gate.mjs`             | The gate's OWN verify pass failed **open**: when all refuters errored, a real finding was silently dropped.                                                                                                                                                                    | **FIXED 2026-06-18** — `verifierFailed` now keeps the finding (fail-closed) + surfaces an `unverified` count.                                                                              |

## Dropped (correctly refuted — recorded for the trail)

- **"Auth guard opt-in → fail-open-by-omission"** (`vlcrm/src/app.ts` 81-95): refuted as
  intended/documented/tested behavior — the `<16`-char throw closes the realistic
  empty-env vector and there is no `serve()` entry point, so zero live exposure. The
  adversarial pass killed a plausible-but-not-genuine finding. Working as designed.

## Suggested sequencing

Harden the **loop foundation** before stacking the SMS bridge / #36 on top
(the "finish before pivoting" rule). Small + high-value first: #1 (boot-crash), #3
(poison-pill whitespace), #2 (constant-time) — each is a few lines and #1/#2 also carry a
**false comment** (the always-fix-stale-data rule). Then #6 (the automated contract guard),
#5 (exactly-once + CPQL truth), #4 (DNC compliance wire-contract).
