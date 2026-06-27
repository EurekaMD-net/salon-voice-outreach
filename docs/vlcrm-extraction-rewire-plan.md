# Plan — rewire salon-voice-outreach to feed from the standalone `vlcrm` repo

**Date:** 2026-06-27 · **Status:** proposed (Phase 0 done)
**New repo:** `EurekaMD-net/vlcrm` (private) — extracted with history, 61/61 tests green.

---

## TL;DR — this is a _decouple-and-deploy_, not a dependency rewire

The orchestrator already talks to vlcrm **over HTTP only**:

- `orchestrator/src/crm-client.ts` — `HttpCrmClient.emit()` does `POST ${CRM_BASE_URL}/events`
  with an optional `Bearer ${CRM_API_KEY}`. It is a PORT; it couples to nothing about vlcrm's code.
- `orchestrator/src/crm-event.ts` — `CrmLeadEvent` is **deliberately a LOCAL type, not imported
  from vlcrm**. Each side of the boundary owns its serialization; vlcrm's `validateLeadEvent`
  is the runtime enforcer (a 400 = drift).

**Consequence:** there is **zero source-level import** from `orchestrator/` → `vlcrm/`. Nothing to
"wire". The rewire is (a) make vlcrm a standalone deployable, (b) point `CRM_BASE_URL` at it,
(c) delete the in-repo `vlcrm/` copy, (d) rehome the one cross-boundary test.

**Risk now: ~zero.** `CRM_BASE_URL` is unset (no `.env` sets it; `null → CRM sync disabled`), and
vlcrm has **no server entrypoint yet** — so the loop isn't live in production. Removing the in-repo
copy breaks no running service.

---

## The only real coupling left to the in-repo copy

| Tie                         | File(s)                                                                                                    | Resolution                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-service contract test | `vlcrm/test/contract.test.ts` (imports orchestrator's `buildCrmEvent` **and** vlcrm's `validateLeadEvent`) | Rehome to `orchestrator/test/` + import vlcrm's validator from the package (see Decision 1)                                                |
| Physical directory          | `vlcrm/`                                                                                                   | Delete after extraction                                                                                                                    |
| Doc/path refs               | `README.md:48`, `workflows/README.md:6,31`, `docs/SPEC-STAGE1-ORCHESTRATOR.md:40,282,302`                  | Update to point at the external repo. (Historical `docs/AUDIT-GATE-FINDINGS-2026-06-18.md` refs are a point-in-time record — leave as-is.) |
| Runtime config              | `CRM_BASE_URL`, `CRM_API_KEY` (orchestrator env)                                                           | Set to the deployed vlcrm URL/key (Phase 2)                                                                                                |

No `.github/workflows` CI exists; no root workspace; `orchestrator/` and `vlcrm/` are independent
packages. So there is no build graph to untangle.

---

## Decision 1 — how to keep the contract test real (RECOMMENDED: build + git devDependency)

The test's value is catching drift between the orchestrator's emitter and vlcrm's _real_ validator.
To keep that after the split, the orchestrator needs `validateLeadEvent` importable.

- **A. Recommended — vlcrm ships a build; orchestrator pulls it as a git devDependency.**
  vlcrm side: add a `dist` build (`tsc` emit), `main`/`types`/`exports`, and a `"prepare": "npm run build"`
  so `npm i -D github:EurekaMD-net/vlcrm` builds on install (works with `private:true`; git installs
  aren't blocked). Orchestrator side: `import { validateLeadEvent } from "vlcrm"`. Durable, real
  validator, **and** this same build is needed for deployment (Phase 2) — so no wasted work.
- **B. HTTP integration test** — orchestrator boots a real vlcrm and asserts `POST /events` accepts
  each disposition. Tests the _actual_ production seam, but still needs vlcrm as a dep to boot it,
  and is heavier in CI. Good as a _later_ addition on top of A.
- **C. Lightweight fallback (no dep)** — vendor vlcrm's `LeadEvent` contract as a committed
  JSON-schema/type fixture in the orchestrator and assert shape. No build pipeline, but it's a copy
  that can drift. Only if avoiding the build is a hard priority.

→ **Go with A.** It unblocks both the test and the deployment.

## Decision 2 — Phase 2 deploy target (defer until the pilot needs live CRM sync)

vlcrm as a localhost-only service behind the orchestrator. Recommend a **systemd tsx unit**
(matches `agentic-crm`) or compiled-JS unit (matches `mission-control`), on a new localhost port
(e.g. `127.0.0.1:33xx`), `TZ=America/Mexico_City`, with `CRM_API_KEY` ≥16 chars. Not opened in UFW.
Pick at deploy time.

---

## Phased execution

### Phase 0 — Standalone repo exists ✅ (done)

- `EurekaMD-net/vlcrm` created, history preserved, `.gitignore`, package renamed `vlcrm`,
  bridge test removed, README updated. 61/61 green, typecheck clean.

### Phase 1 — Decouple salon from the in-repo copy (NO deploy required, do now)

1. **vlcrm repo:** add the build + `exports` (Decision 1A). New patch commit + push.
2. **orchestrator:** `npm i -D github:EurekaMD-net/vlcrm`.
3. Move `vlcrm/test/contract.test.ts` → `orchestrator/test/contract.test.ts`; rewrite the vlcrm
   import to `from "vlcrm"` (the `buildCrmEvent`/`Disposition` imports become local relative paths).
4. **Delete** the `vlcrm/` directory from salon-voice-outreach.
5. Update docs/path refs (`README.md:48` → external repo link; drop "all in-repo" wording at
   `README.md:11-16`; `workflows/README.md:6,31`; `SPEC-STAGE1-ORCHESTRATOR.md:40,282,302`).
6. **Verify:** `cd orchestrator && npm run typecheck && npx vitest run test/` green (note: orchestrator
   test count rises by the rehomed contract test; update the README count).
7. Branch + PR (matches the repo's branch-first policy), merge.

**End of Phase 1:** salon-voice-outreach contains only `orchestrator/` + `workflows/` + docs; it
consumes vlcrm as an external package for the contract test and over HTTP at runtime. Nothing is
deployed differently yet (CRM sync still env-gated off).

### Phase 2 — Deploy vlcrm as a service (when the pilot needs CRM sync live)

1. **vlcrm repo:** add `@hono/node-server` + `src/server.ts` (listener; DB path, port, `apiKey` from
   env). Add tests for boot/healthz. Commit + push.
2. Deploy (Decision 2): systemd unit on a localhost port, generate `CRM_API_KEY` (≥16 chars).
3. **orchestrator env:** set `CRM_BASE_URL=http://127.0.0.1:<port>` + matching `CRM_API_KEY`.
4. Verify end-to-end: drive one call_attempt through the outbox pump → confirm an `interaction`
   row + CPQL rollup at vlcrm.

---

## Rollback

- Phase 1 is a structural/code change behind a PR — revert the PR. The deleted `vlcrm/` is preserved
  in git history and in the standalone repo.
- Phase 2 is config — unset `CRM_BASE_URL` (→ sync disabled) to fully back out at runtime.

## Install note (this VPS / CI)

`vlcrm` is a **private** repo. `orchestrator/package.json` pins it as `git+https://…`, but npm
canonicalizes the lockfile `resolved` to `git+ssh://git@github.com/…` and that form **cannot be
overridden** (npm rewrites it on every install; the lock is also tooling-protected against hand-edits).
Installs nonetheless work on this VPS because git is configured to rewrite GitHub SSH→HTTPS and `gh`
supplies the HTTPS token:

```bash
git config --global url."https://github.com/".insteadOf "git@github.com:"
git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"
```

**Consequence for `npm ci` anywhere else:** it needs private-repo access **and** either an SSH key or
the same `insteadOf` rewrite above (because the lock says `ssh`). No CI runs on this repo today; if one
is added, add the rewrite (or an SSH deploy key) + a token to the runner.

## Open decisions to confirm before executing

1. Contract-test strategy → **A** (build + git devDependency) unless you prefer C (no build).
2. Do Phase 1 now and defer Phase 2 to pilot-time? (recommended) — or do both together.
3. Phase 2 deploy target (systemd vs Docker, port) — only needed at Phase 2.
