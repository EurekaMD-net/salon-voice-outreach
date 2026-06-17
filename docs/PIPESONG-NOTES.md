# Pipesong integration notes — what the orchestrator must know

Distilled from a full read of pipesong's docs (`README`, `PLAN`, `docs/PROGRESS`,
`phase0-benchmarks`, `phase1-plan`, `tts-stt-upgrade-research`, audits 1–4a) + direct
code verification (2026-06-17). pipesong is the **voice engine**; this repo is the
**orchestrator** that drives it. **pipesong is private IP** (`kosm1x/pipesong`).

Legend: ✅ = verified in code · 📄 = from docs (confirm before depending on it).

---

## 1. The integration contract — what we build ON

**Originate a call** ✅ (`src/pipesong/api/outbound.py:23-36`)

```
POST /calls/outbound        (Bearer API key)
{ "agent_id": "<uuid>", "to_number": "+52155…", "variables": { "nombre": "...", "colonia": "..." } }
→ 201 { call_id, status, to_number, from_number }
```

Internally calls Telnyx `POST /v2/calls`; on answer Telnyx streams audio to our WS
with `?call_id=&agent_id=`.

**Per-call personalization** ✅ (`main.py:184-192`) — agent `variables` merged with
per-call `variables`, then `system_prompt.replace("{{key}}", value)`. So the
salon-opener prompt uses `{{nombre}}` / `{{colonia}}`; the orchestrator passes them
per dial. (String substitution only — no conditionals; complex flows = Phase 4b, not built.)

**Agent model** 📄 (`POST /agents`): `system_prompt`, `language`, `voice` (`em_alex`),
`disclosure_message` (**mandatory** — recorded-call consent, LFPDPPP), `tools[]`,
`webhook_url` + `webhook_secret`, `variables`, `max_call_duration`, `knowledge_base_id`,
`vad_stop_secs`, `vad_confidence`.

**Tools** 📄 — registered per-agent as HTTP endpoints `{name, description, endpoint,
method, parameters}`; LLM emits JSON → pipesong executes the HTTP call → injects result.
**This is our handoff seam:** register `send_whatsapp_optin` as a tool pointing at the
orchestrator. (Caveat: Qwen prompt-based tool-calling ~60% reliable — keep tool schemas
minimal, 1 arg ideally.)

**Webhooks** 📄 — fire-and-forget POST on `call_started` / `call_ended`, HMAC-SHA256
signed (`X-Pipesong-Signature`, verify with `webhook_secret`). **This is our outcome
seam:** subscribe to write disposition + transcript into our state machine + CRM.

---

## 2. Engine constraints to respect

- **GPU concurrency is the scale ceiling** 📄 — 1× RTX 4090 (Qwen 7B AWQ + Kokoro) holds
  **~30 concurrent calls** at acceptable latency; LLM TTFT degrades past ~25, overflow to
  Groq at ~30-35, need a 2nd GPU past ~35. **The pacing loop's concurrency cap must track
  GPU capacity** (start small).
- **Latency** ✅/📄 — ~830ms p50 (Deepgram ~260 + Qwen ~120 + Kokoro ~450). Fine for the call.
- **Telnyx** 📄 — current DID is **US (+12678840093)**; MX outbound ~$0.015/min vs US
  $0.007; MX DIDs exist ($20-30/mo) but **quality untested** (Twilio is the fallback).
  Respect Telnyx **CPS (calls-per-second)** limits in the pacing loop.
- **All-in cost** 📄 — ~$0.025-0.035/min calling MX. Dominant variable = GPU hours (ours).
- **Disclosure is enforced** 📄 — no agent activates without `disclosure_message`. Good —
  it's our legal consent leg, free.

---

## 3. Gaps pipesong does NOT provide → **this repo owns them**

| Need                                            | pipesong status                     | Our responsibility                                                                                    |
| ----------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Batch / dispatch** (loop a list, pace, retry) | ❌ no batch API (Phase 6)           | Orchestrator IS this — loop `POST /calls/outbound` per prospect under concurrency + CPS + window caps |
| **Qualification branching**                     | ❌ no conversation flows (Phase 4b) | Keep the call linear (qualify → 1 tool); branch logic lives in the tool/orchestrator, not the call    |
| **Monitoring / dashboards**                     | ❌ no Grafana (Phase 5)             | Our obs endpoint + answer-rate health monitor; query `calls`/`transcripts`/`call_latency` directly    |
| **Voicemail detection**                         | ❌ (Phase 6)                        | Treat as `no_answer`/`voicemail` disposition; cap attempts; don't spam VMs                            |

---

## 4. Spanish / TTS learnings to inherit (don't rediscover)

- **Qwen code-switches to Chinese mid-response** — `SpanishOnlyFilter` (`processors.py`)
  strips non-Latin + fixes tokenizer spaces; 100% effective. System prompt alone is
  insufficient. (Our prompt still says "responde SIEMPRE en español.")
- **Kokoro comma→period trick** — flushes TTS at clause boundaries; cut TTFB 2.3s→~450ms.
  Inaudible at 8kHz phone quality. Already in the filter.
- **VAD** — Mexican salons are noisy; use conservative `vad_stop_secs` (~0.3-0.5) so the
  agent doesn't interrupt slow/background-noise speakers.
- **Prosody** — `em_alex` acceptable, not yet "natural" (open); custom MX voice deferred.

---

## 5. Open risks to design around

- **Deepgram STT = single point of failure** (faster-whisper fallback adds 500-1000ms).
- **Telnyx MX routing quality unproven** — pilot a few real MX calls before scaling; Twilio fallback.
- **No HA on the GPU box** — a crash drops live calls; plan supervision + alert.
- **Qwen tool-calling ~60%** — minimal tool schemas; the `send_whatsapp_optin` tool should
  take just `prospect_id` (or be triggerable by the orchestrator from the transcript as a backup).

---

## 6. Source map (in pipesong repo)

`api/outbound.py` (originate) · `api/agents.py` (agent model) · `main.py:166-235`
(variable merge/substitution, WS handler) · `pipeline.py` (Pipecat assembly) ·
`processors.py` (SpanishOnlyFilter, tools, metrics, RAG) · `docs/PLAN.md` (cost/GPU/
phases) · `docs/PROGRESS.md` (status) · audits 1–4a (resolved findings).
