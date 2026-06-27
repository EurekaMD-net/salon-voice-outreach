# salon-voice-outreach

Voice-first outbound acquisition engine for **Gilda** (gilda.mx) — reaching CDMX
salon / barber / nail owners at scale and routing interested owners into the
**inbound** WhatsApp funnel that closes them.

> **Status (2026-06-27):** design complete; **build underway**.
> **Orchestrator Stage 1** — capture spine + fail-closed guardrails/kill-switch, the
> pipesong-agnostic dialer core (`PipesongClient` port + state machine + pacing loop +
> reaper), and the **CRM emitter** (`CrmClient` port + outbox pump: every finalized
> `call_attempt` drains to vlcrm at-least-once) — shipped & QA-gated, **106 tests**
> (includes the cross-service contract test against vlcrm's validator).
> **vlcrm** — the lead-intake spine (4-table pipeline of record, agnostic `LeadEvent`
> ingest port, sales-phone manual intake with structured **referral**) + the **CPQL
> rollup** (`GET /metrics/cpql`) — now lives in its **own repo** (`EurekaMD-net/vlcrm`).
> **The two services talk over HTTP** (orchestrator → `POST /events` → vlcrm → CPQL); the
> orchestrator also consumes `vlcrm` as a git devDependency for the contract test.
> Extracted 2026-06-27 — see `docs/vlcrm-extraction-rewire-plan.md`.
> The loop was then **hardened** against 6 findings from a multi-lens `audit-gate` pass
> (boot-crash migration, constant-time auth, whitespace poison-pill, DNC suppression,
> exactly-once `refId` dedup, automated cross-service contract test) — see
> `docs/AUDIT-GATE-FINDINGS-2026-06-18.md`.
> The pipesong-coupled parts (webhook→outcome handler, agent registration + handoff) wait
> for the in-flight pipesong Pipecat-1.x/Flux upgrade to merge to `main` (currently on an
> unvalidated branch; watched). Private — it touches prospect PII.

## The load-bearing decision

**A call's only job is to qualify and hand off — never to sell, and never to push
an outbound WhatsApp.** A salon owner who says "sí, mándame info" receives a
**transactional SMS with a `wa.me` deep-link**; they tap it and message the brand
number first → **100% inbound WhatsApp** → the product bot closes.

This keeps every WhatsApp touch inbound (ban-safe), keeps calls short (cost), and
puts the close in the channel that converts. **Voice = opener, SMS = bridge,
inbound WhatsApp = closer.**

Why this matters: the predecessor pilot (`EurekaMD-net/gilda-outreach`) proved that
cold _outbound_ WhatsApp from a server-side client gets the number permanently
banned on the first send. That lesson is the founding constraint of this repo — see
`docs/ARCHITECTURE.md` §0 and §6.

## How the pieces fit

| Component        | Role                                                                                                    | Where                           |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **pipesong**     | Voice engine (Telnyx PSTN + Deepgram/Qwen/Kokoro, RAG, tools, webhooks, outbound calls) — already built | `kosm1x/pipesong`               |
| **orchestrator** | Campaign orchestrator: who to call, pacing, windows, retries, DNC, handoff, CRM wiring                  | `orchestrator/`                 |
| **salones-wa**   | Inbound WhatsApp product bot — the closer                                                               | `salones-wa`                    |
| **vlcrm**        | Pipeline of record + channel attribution (CPQL); agnostic `LeadEvent` port + sales-phone intake         | `EurekaMD-net/vlcrm` (own repo) |
| **DENUE spine**  | ~23k CDMX salon prospects (name, colonia, phone, IG)                                                    | —                               |

## Docs

- [`docs/VISION.md`](docs/VISION.md) — **start here.** Where the moat is (the data
  flywheel, not pipesong), the 6-layer stack, how intent/data thread up and down, and
  the 3 build stages (Pipe → Loop → Flywheel) with what comes first.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full system design (orchestrator,
  conversation flow, data model, compliance-by-design, telephony, cost, phased build).
- [`docs/PIPESONG-NOTES.md`](docs/PIPESONG-NOTES.md) — the voice engine's real contract,
  constraints, gaps this repo must fill, and Spanish/TTS learnings (verified against
  pipesong code 2026-06-17). Read before building the orchestrator.
- [`docs/SPEC-STAGE1-ORCHESTRATOR.md`](docs/SPEC-STAGE1-ORCHESTRATOR.md) — **the current
  build spec.** Stage 1 ("The Pipe"): capture-first data model, state machine, pacing
  loop, pipesong contract, the ban-safe handoff, guardrails, acceptance criteria.

## Guardrails (compliance-by-design, day 1)

Built _before_ scale, not after (the gilda-outreach lesson): enforced call window,
permanent DNC, frequency caps, recorded-call disclosure, an answer-rate health
monitor with a real alert + `CAMPAIGN_ENABLED=false` kill-switch. See
`docs/ARCHITECTURE.md` §6.
