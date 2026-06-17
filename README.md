# salon-voice-outreach

Voice-first outbound acquisition engine for **Gilda** (gilda.mx) — reaching CDMX
salon / barber / nail owners at scale and routing interested owners into the
**inbound** WhatsApp funnel that closes them.

> **Status:** design phase (2026-06-17). This repo holds the architecture and
> conversation design first; the orchestrator implementation follows. Private by
> design — it will touch prospect PII.

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

| Component       | Role                                                                                                    | Where             |
| --------------- | ------------------------------------------------------------------------------------------------------- | ----------------- |
| **pipesong**    | Voice engine (Telnyx PSTN + Deepgram/Qwen/Kokoro, RAG, tools, webhooks, outbound calls) — already built | `kosm1x/pipesong` |
| **this repo**   | Campaign orchestrator: who to call, pacing, windows, retries, DNC, handoff, CRM wiring                  | —                 |
| **salones-wa**  | Inbound WhatsApp product bot — the closer                                                               | `salones-wa`      |
| **agentic-CRM** | Pipeline of record + CPQL attribution by channel                                                        | —                 |
| **DENUE spine** | ~23k CDMX salon prospects (name, colonia, phone, IG)                                                    | —                 |

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
