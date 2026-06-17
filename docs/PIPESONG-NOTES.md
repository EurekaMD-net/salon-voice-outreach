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

---

## 7. Component-upgrade intel — session 2026-06-17 ("pipesong gilda")

Triggered by a Jarvis (mission-control) stack-review whose specifics were fact-checked
against PyPI / Pipecat / Deepgram / Qwen **primary sources** (Jarvis got several wrong —
see 7.4). **Framing caveat for everything below: the Phase 4a `4a.6` GPU baseline has
never run** — the latency numbers in §2/§4 are doc-derived, not measured on hardware, and
the GPU box (TensorDock RTX 4090) is currently off. No upgrade is "worth it" until the
before-numbers exist. pipesong is now formally **proprietary** (LICENSE relicensed
MIT → All-Rights-Reserved / VoxPopulai, commit `0bd8528`).

### 7.1 Verified current → latest (pinned in pipesong code/deps)

| Component   | Pinned now (source)                         | Latest (verified)             | Note for the orchestrator                                                  |
| ----------- | ------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| Pipecat     | 0.0.106 (`requirements.txt`)                | 1.4.0 (PyPI, rel. 2024-12)    | 1.x migration is SMALL here — code already uses new LLMContext/imports/VAD |
| STT         | Deepgram Nova-3 (`pipeline.py:69`, `es`)    | Nova-3 + **Flux** (new)       | Flux = integrated transcription+turn-detection, not a turn add-on (7.3)    |
| LLM server  | vLLM 0.6.6 (forced — V1 crashed TensorDock) | 0.2x                          | upgrade re-triggers the V1-crash risk → must re-validate on GPU            |
| LLM model   | Qwen2.5-7B-Instruct-AWQ (`config.py:15`)    | **Qwen3-8B** (there is no 7B) | **directly fixes the ~60% tool-calling risk in §1/§5** (native tool-call)  |
| TTS         | Kokoro em_alex (`config.py:18`)             | Supertonic 2 / Qwen3-TTS      | see 7.2                                                                    |
| Turn detect | Silero VAD + Smart Turn v3                  | Flux can absorb endpointing   | see 7.3                                                                    |

### 7.2 TTS upgrade verdict (research doc + verification)

- **Supertonic 2** (research doc's #1): TTS ~450ms → ~20ms on CPU, ~50-LOC adapter. License
  **OpenRAIL-M** (commercial OK + must disclose AI — we already do via `disclosure_message`).
  **No voice cloning.** Biggest single latency win. (Jarvis omitted this entirely.)
- **Qwen3-TTS 0.6B** (Apache 2.0, 3s voice clone): the path to a **custom "Bibi" MX voice** —
  closes the §4 "custom MX voice deferred" open item. But no HTTP server / no Pipecat
  integration / real-GPU latency 150-300ms (NOT the 97ms paper figure) → higher effort.

### 7.3 Deepgram Flux + Pipecat 1.x (the track chosen this session)

- **Flux REPLACES Nova-3** — one model does transcription + end-of-turn together. Adopting it
  swaps proven Nova-3-`es` for `flux-general-multi` → **gate on a Spanish-WER A/B, not just the
  ~100-200ms turn-latency win.** Separate v2 endpoint + distinct product → confirm Flux pricing
  vs the $0.0043/min Nova-3 line in §2.
- Wiring (verified vs Pipecat/Deepgram docs): `DeepgramFluxSTTService`
  (`pipecat.services.deepgram.flux`) + `LLMUserAggregatorParams(user_turn_strategies=
ExternalUserTurnStrategies())` removes Silero VAD + Smart Turn. EOT tuning =
  `eot_threshold` (0.5-0.9, def 0.7) / `eager_eot_threshold` (faster, more LLM calls/cost) /
  `eot_timeout_ms`. **Orchestrator impact:** for Flux agents these knobs SUPERSEDE the §1
  agent-model `vad_stop_secs` / `vad_confidence` columns.
- Full plan + diffs: `pipesong/docs/upgrade-flux-pipecat1x-2026-06-17.md`. **Status: PREPARED,
  not applied;** gated on Python 3.11+, the `4a.6` baseline, and the WER A/B.

### 7.4 Corrections to Jarvis's mission-control answer (do NOT propagate its errors)

- No "Qwen3 **7B**" (dense ladder = 0.6/1.7/4/8/14/32B → use **8B**). "vLLM **DeepSeek V4**"
  unverifiable. Pipecat 1.4.0 is real but released **2024-12, not "today"**. Kokoro real TTFB
  is **389-554ms** (Jarvis said 100-200ms). Deepgram **Flux** and **Nova-3 Medical** ARE real
  (confirmed in Deepgram docs).
