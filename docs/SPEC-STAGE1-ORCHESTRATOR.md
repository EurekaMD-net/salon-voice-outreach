# Spec — Stage 1: The Pipe (orchestrator)

**Status:** spec / not built. Implements **VISION §4 Stage 1** — prove one closed loop,
instrumented & guarded, on the preserved 296 Iztapalapa list. Built on the verified
pipesong contract (`PIPESONG-NOTES.md`).

---

## 0. Scope

**Goal:** one real prospect → real call → qualified → SMS `wa.me` → inbound WhatsApp →
outcome recorded. Prove the funnel converts at all; get a **baseline CPQL**; capture
every call's data from #1 so Stage 2 (the loop / moat) has a corpus.

**In scope:** the salon-opener agent (linear), the orchestrator (state machine + pacing

- guardrails + capture), the SMS `wa.me` handoff, the webhook→outcome handler, the
  answer-rate health monitor + kill-switch.

**Out of scope (later stages):** the learning loop / recirculation (Stage 2),
multi-channel (SMS/ads cold), scale infra, conversation-flow branching, fine-tuning.

**Non-negotiable (VISION):** capture + guardrails are the **spine**, built before the
first dial. Uncaptured calls are lost forever; an unguarded dialer repeats the gilda burn.

---

## 1. Service shape — DECISIONS LOCKED 2026-06-17

The entire **proprietary stack we build is TypeScript** (very-light methodology: Hono +
SQLite + heavy tests + minimal deps). **pipesong is the lone Python commodity, touched
ONLY over HTTP** — so the orchestrator does not need to be Python; co-location was the only
reason and it's a weak one. One language for L1–L4 matches the TS-runtime principle and the
vlcrm.

- **Orchestrator** — `orchestrator/` — **TypeScript / Hono + better-sqlite3**, its **own
  SQLite store** (`data/orchestrator.db`). It references `pipesong_call_id` and stores the
  webhook **raw payload (incl. transcript)** for the Stage-2 corpus; recordings stay
  referenced in pipesong's MinIO. No shared Postgres — pipesong is HTTP-only.
- **vlcrm** — `vlcrm/` — **TypeScript / Hono + SQLite** (same methodology), the pipeline of
  record + human workspace + CPQL. Consumes lifecycle events from the orchestrator over a
  thin idempotent HTTP seam. (See ARCHITECTURE for the seam contract.)
- **GPU:** reuse pipesong's RTX-4090 for the minimum-stack test → Stage 1 concurrency cap
  **≤3**; dedicated GPU at scale (Stage 3).
- **Telnyx:** **single vendor** for voice **+** MX SMS, but the SMS leg sits behind a
  **swappable `send_sms()` adapter**; measure MX deliverability (DLR) in Stage 1; start MX
  A2P registration early. Swap to a specialist if deliverability underperforms.
- **System of record (Stage 1):** orchestrator SQLite for dialing/capture; vlcrm SQLite for
  the lead pipeline. (No media CRM — that stack is for TV/media, different flows.)
- **Handoff target:** the salones-wa **brand WhatsApp number** (inbound) = the `wa.me` link.

---

## 2. Data model — built FIRST (the L4 capture spine)

Schema `outreach` on pipesong's Postgres.

```sql
-- the prospect graph (L1)
CREATE TABLE outreach.prospect (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text,
  colonia       text,
  phone_e164    text UNIQUE NOT NULL,          -- +52155…, validated
  ig_handle     text,
  source        text NOT NULL DEFAULT 'denue-iztapalapa-2026-06',
  state         text NOT NULL DEFAULT 'queued' -- see §3
                  CHECK (state IN ('queued','dialing','no_answer','voicemail',
                    'connected','qualified','declined','dnc','optin_sent',
                    'inbound_received','won','lost','exhausted','invalid')),
  attempts      int  NOT NULL DEFAULT 0,
  last_attempt_at  timestamptz,
  next_eligible_at timestamptz NOT NULL DEFAULT now(),
  crm_lead_id   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_prospect_state_eligible ON outreach.prospect(state, next_eligible_at);

-- every call attempt = the capture row (L4 raw)
CREATE TABLE outreach.call_attempt (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id     uuid NOT NULL REFERENCES outreach.prospect(id),
  campaign_id     uuid NOT NULL,
  pipesong_call_id uuid,                        -- join key to pipesong.calls
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  duration_s      int,
  disposition     text,                         -- no_answer|voicemail|connected|qualified|declined|dnc|failed
  optin_sent      boolean NOT NULL DEFAULT false,
  transcript_ref  text,                         -- pointer into pipesong transcripts
  recording_ref   text,
  raw             jsonb                          -- full webhook payload (capture everything; mine later)
);
CREATE INDEX ix_call_prospect ON outreach.call_attempt(prospect_id, started_at DESC);

CREATE TABLE outreach.dnc (
  phone_e164  text PRIMARY KEY,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outreach.campaign (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  agent_id     uuid NOT NULL,                    -- pipesong salon-opener agent
  status       text NOT NULL DEFAULT 'paused',   -- paused|active|stopped
  window_cfg   jsonb NOT NULL,
  pacing_cfg   jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

> **Capture-everything rule:** `call_attempt.raw` stores the full webhook payload + any
> tool-call args verbatim. Stage 2's mining needs data we didn't know we'd want — store it now.

---

## 3. State machine

```
queued ──dial──▶ dialing ──┬─ no answer ───▶ no_answer ──(attempts<2)──▶ queued (backoff)
                           │                            └─(attempts=2)──▶ exhausted
                           ├─ voicemail ───▶ voicemail ──(same retry rule)
                           ├─ connected ──▶ connected ──┬─ optin tool fired ─▶ qualified
                           │                            ├─ "no me llames" ───▶ dnc (terminal)
                           │                            └─ ends, no optin ───▶ declined (terminal)
                           └─ telephony fail ─▶ (retry per rule)

qualified ──SMS wa.me sent──▶ optin_sent ──inbound WA seen──▶ inbound_received ─▶ won | lost
```

- **Authoritative "qualified" signal** = the `send_whatsapp_optin` tool fires (our endpoint),
  _not_ a transcript guess.
- `inbound_received` is set when salones-wa reports an inbound from that number (Stage 1:
  manual/lightweight match on the prefilled `text`; auto-match later).
- Terminal: `declined`, `dnc`, `exhausted`, `invalid`, `won`, `lost`.

---

## 4. Pacing loop (the dialer)

Runs every ~30s. Kill-switch checked first.

```python
if not CAMPAIGN_ENABLED: return                      # hard stop
if not within_window(now): return                    # Mon–Sat 10:00–19:00 MX
free = MAX_CONCURRENT_CALLS - count(state='dialing')
if free <= 0: return
batch = SELECT * FROM prospect
        WHERE state='queued' AND next_eligible_at<=now
          AND phone_e164 NOT IN (SELECT phone_e164 FROM dnc)
          AND attempts < MAX_ATTEMPTS                 # = 2
        ORDER BY next_eligible_at
        LIMIT min(free, TELNYX_CPS_BUDGET)
for p in batch:
    set p.state='dialing', attempts+=1, last_attempt_at=now
    call_id = pipesong POST /calls/outbound {agent_id, to_number=p.phone_e164,
                                             variables={nombre:p.name, colonia:p.colonia}}
    insert call_attempt(prospect_id=p.id, pipesong_call_id=call_id, ...)
```

- **Window:** `Mon–Sat 10:00–19:00 America/Mexico_City` (salon hours; no Sundays).
- **Concurrency cap:** `MAX_CONCURRENT_CALLS` (Stage 1 = 3) — bounded by shared GPU.
- **Frequency cap:** `MAX_ATTEMPTS = 2`; `no_answer/voicemail` → backoff `next_eligible_at =
now + RETRY_BACKOFF_HOURS` then re-queue; `declined`/`dnc` never re-queue.
- **CPS:** respect Telnyx calls-per-second.

---

## 5. pipesong integration (verified contract)

**Salon-opener agent** (register once via `POST /agents`): linear Spanish flow,
`disclosure_message` set (legal), `voice=em_alex`, `vad_stop_secs≈0.4` (noisy salons),
two minimal tools, webhook→orchestrator (HMAC). System prompt uses `{{nombre}}`/`{{colonia}}`.

**Originate** ✅ `POST /calls/outbound { agent_id, to_number, variables:{nombre,colonia} }`
→ `201 { call_id, ... }`. pipesong substitutes `{{nombre}}`/`{{colonia}}` per call (`main.py:192`).

**Tools** (HTTP, pointed at the orchestrator; keep schemas 1-arg — Qwen tool-calling ~60%):

- `send_whatsapp_optin(prospect_id)` — fired when the owner agrees.
- `mark_dnc(prospect_id)` — fired on "no me llames" (DNC is a compliance must).
  Backstop: post-call transcript scan for opt-out phrases also writes `dnc`.

---

## 6. The handoff (ban-safe — VISION's load-bearing decision)

`send_whatsapp_optin` → orchestrator `POST /handoff/optin {prospect_id}`:

1. Send a **transactional SMS** (Telnyx) to the prospect:
   `"Soy Bibi de Gilda 👋 Abre tu WhatsApp aquí para platicar: wa.me/<WA_BRAND_NUMBER>?text=Hola%20Gilda"`
2. Set `prospect.state='optin_sent'`, `call_attempt.optin_sent=true`.
3. The prospect taps → messages the **brand number** first → **inbound** → salones-wa closes.

No outbound WhatsApp is ever sent. SMS is transactional + consented (verbal yes on a
recorded call). This is the entire reason the architecture exists.

---

## 7. Webhook → outcome handler (the capture)

`POST /webhooks/pipesong` (HMAC-verify `X-Pipesong-Signature` with `PIPESONG_WEBHOOK_SECRET`):

- `call_started` → confirm `call_attempt`, mark `dialing`→`connected` on answer.
- `call_ended` → set `ended_at`, `duration_s`, `transcript_ref`, store full payload in
  `raw`; derive `disposition`:
  - `optin_sent` already true → `qualified`
  - `mark_dnc` fired / opt-out phrase → `dnc`
  - answered + ended, no optin → `declined`
  - never answered / very short → `no_answer` (or `voicemail` if VM detected)
  - then apply the retry rule (§4).

**System of record = the orchestrator's tables for Stage 1.** CRM sync (`source=pipesong-voice`,
channel-tagged, for CPQL) is a thin later wiring once the agentic-CRM is back up.

---

## 8. Compliance & guardrails (day 1 — the "ban-watch analog", built right)

- **Kill-switch:** `CAMPAIGN_ENABLED=false` halts all dialing (checked first in the loop).
- **Call window** enforced (no out-of-window dials).
- **DNC** permanent + instant (`mark_dnc` tool + transcript backstop); honored across runs.
- **Frequency cap** (≤2 attempts; declined/dnc never re-dialed).
- **Disclosure** — pipesong-native, mandatory.
- **Answer-rate health monitor** — a **real** scheduled job (not a directive-only stub —
  the gilda lesson): every N min compute rolling answer-rate + VM-rate; if answer-rate
  craters or VM-rate spikes → **auto-pause** (`CAMPAIGN_ENABLED→false`) + alert operator
  (Telegram). **Verify it actually fires** before launch (trace one real tick).
- **Caller-ID hygiene:** consistent MX DID; monitor answer-rate as the health signal.

---

## 9. Observability

`GET /health` → `{ ok, campaign_enabled, dialing, today_dialed }` (no token, for the monitor).
`GET /funnel?token=…` → counts by state + connect/qualify/optin/inbound rates + CPQL inputs.
All numbers from SQL on `prospect` / `call_attempt`. (Grafana = Stage 3.)

---

## 10. Config / env

```
CAMPAIGN_ENABLED=false                 # kill-switch, default OFF
OUTREACH_DB_URL=…                      # pipesong Postgres
PIPESONG_BASE_URL=… / PIPESONG_API_KEY=…
SALON_OPENER_AGENT_ID=…
PIPESONG_WEBHOOK_SECRET=…              # HMAC
WA_BRAND_NUMBER=52155…                 # the wa.me handoff target (salones-wa)
TELNYX_API_KEY=… / TELNYX_MX_DID=… / TELNYX_MESSAGING_PROFILE_ID=…
WINDOW_DAYS=1-6  WINDOW_START_HOUR=10  WINDOW_END_HOUR=19   # MX
MAX_CONCURRENT_CALLS=3  MAX_ATTEMPTS=2  RETRY_BACKOFF_HOURS=24
ANSWER_RATE_FLOOR=0.10                  # below → auto-pause + alert
ALERT_TELEGRAM_BOT_TOKEN=… / ALERT_TELEGRAM_CHAT_ID=…
```

---

## 11. Build order (capture-first)

1. **Schema + guardrails skeleton** — `outreach` tables, `CAMPAIGN_ENABLED`, window/DNC/
   freq-cap checks, the answer-rate monitor + kill-switch. (The spine, before any dial.)
2. **Salon-opener agent + handoff** — register agent; `send_whatsapp_optin`/`mark_dnc`
   tools; `/handoff/optin` → SMS `wa.me`. Test with a single manual `POST /calls/outbound`.
3. **Webhook → outcome handler** — HMAC verify, disposition mapping, `raw` capture.
4. **Pacing loop** — state machine + dialer; run against the 296 within the window.

---

## 12. Acceptance criteria (Stage 1 "done")

- 296 dialed only within windows; **DNC honored**; ≤2 attempts each; kill-switch verified.
- **Every** call writes a `call_attempt` row with disposition + transcript_ref + `raw`.
- **≥1 end-to-end proof:** qualified → optin SMS → **inbound WA arrives at salones-wa**.
- Baseline metrics computable from SQL: connect-rate, qualify-rate, optin→inbound-rate, **CPQL**.
- Answer-rate monitor **fires a real alert** in a test (traced, not assumed).

---

## 13. Open questions — RESOLVED 2026-06-17

- GPU → **reuse pipesong's 4090 for the pilot; dedicated at scale.** ✓
- Telnyx → **single vendor (voice + MX SMS), SMS behind a swappable adapter.** ✓
- Orchestrator language/placement → **TypeScript, in-repo `orchestrator/`, own SQLite,
  pipesong HTTP-only.** ✓
- CRM → **new in-repo `vlcrm/` (TS/Hono+SQLite, very-light); the media CRM is out of scope.** ✓

**Still open (real work, not decisions):** MX A2P SMS registration (lead-time — start now)
and acquiring MX local DID(s) — today's pipesong DID is US; pilot a few live MX calls first,
Twilio as the SMS/voice fallback.
