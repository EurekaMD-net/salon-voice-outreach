# Architecture — salon-voice-outreach

**Draft v0.1 — 2026-06-17.** Initial design. Sections marked _open_ are decisions
still to confirm.

---

## 0. The load-bearing decision

**The call's only job is to qualify and hand off — never to sell or to push an
outbound WhatsApp.** A salon owner who says _"sí, mándame info"_ gets a
**transactional SMS with a `wa.me` deep-link** → they tap it → _they_ message the
brand number first → **100% inbound WhatsApp** → the product bot (`salones-wa`)
closes.

This keeps every WhatsApp touch inbound (ban-safe — the `gilda-outreach` lesson),
keeps calls short (cost), and puts the close in the channel that converts.
**Voice = opener, SMS = bridge, inbound WhatsApp = closer.**

---

## 1. What exists vs. what we build

| Layer                                                                           | Status                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------- |
| Voice engine (STT/LLM/TTS ~830ms, RAG, tools, HMAC webhooks)                    | pipesong — done                             |
| Single outbound call origination                                                | pipesong `api/outbound.py` — done (Phase 2) |
| **Campaign/dialer orchestrator** (who/when/next: pacing, retries, windows, DNC) | build                                       |
| **Cold-salon conversation design** (prompt + qualify flow + handoff tool)       | build                                       |
| **Ban-safe handoff** (qualified → SMS `wa.me` → inbound WA)                     | build                                       |
| **CRM + outcome wiring** (pipesong webhooks → pipeline state, CPQL)             | build                                       |
| **MX telephony** (local DIDs, caller-ID reputation)                             | acquire (today's DID is US)                 |
| **Compliance + monitoring + kill-switch**                                       | build _first_, not last                     |

We are not building voice. We are building an **orchestrator that drives pipesong**.

---

## 2. End-to-end architecture

```
DENUE 23k spine ──load──▶ Orchestrator (NEW, Python, shares pipesong's Postgres)
(name, colonia,            │  • dedupe + E.164 validate + DNC filter
 phone, IG)                │  • pacing loop: window + concurrency + retry/backoff
                           │  • per-prospect frequency cap
                           ▼
                  pipesong POST /outbound  ◀──webhook events (HMAC)──┐
                  (agent=salon-opener,                               │
                   per-call vars: nombre, colonia)                   │
                           │                                         │
                           ▼                                         │
                  ☎ Telnyx MX DID ──▶ live call ──▶ Deepgram/Qwen/Kokoro
                           │                                         │
            ┌──────────────┼─────────────────────┐                  │
       qualified       not_interested         no_answer/VM           │
            │               │                     │                  │
   tool: send_optin    mark + suppress      retry once / DNC ────────┘
            │
            ▼
   Transactional SMS  "Soy de Gilda. Abre tu chat: wa.me/52155XXXX?text=hola"
            │
            ▼
   Prospect taps ─▶ INBOUND WhatsApp ─▶ product bot (salones-wa) ─▶ demo/close
            │
            └─▶ all outcomes ─▶ CRM (source=pipesong-voice, channel-tagged) ─▶ CPQL
```

---

## 3. The orchestrator — the main build

A **separate** thin Python service (keep pipesong a clean single-purpose engine;
the orchestrator owns "who/when/next" — same separation as gilda's sender-vs-analyst
split). Core = a per-prospect **state machine** + a **pacing loop**.

**State machine**

```
queued → dialing → {no_answer, voicemail, connected}
                 → {qualified, declined, dnc}
                 → optin_sent → inbound_received → won / lost
```

**Pacing loop (every tick)**

```
eligible = prospects WHERE state = queued
  AND now ∈ call_window               (Mon–Sat ~10:00–19:00 MX, salon hours)
  AND next_eligible_at <= now
  AND phone NOT IN dnc
  AND attempts < max_attempts (= 2)
take min(eligible, free_concurrency_slots)   # slots = f(GPU capacity, Telnyx channels)
for each → pipesong POST /outbound(agent_id, prospect vars)
```

Concurrency cap is the real throttle — each live call consumes GPU (vLLM + Kokoro).
Pilot: a handful concurrent; scale = more GPU.

---

## 4. Conversation design

**Persona:** _Bibi de Gilda_ — warm, brief, Mexican Spanish, not salesy. Disclosure
on connect (pipesong native `disclosure_message` = recorded-call consent).

**Flow (≤ 60–90 s target)**

1. Disclosure + greeting — _"Hola, ¿hablo con el salón {nombre}? Soy Bibi, de Gilda…"_
2. One-line value + permission — _"…ayudamos a salones de {colonia} a llenar su
   agenda con citas por WhatsApp. ¿Te late que te mande la info por WhatsApp para
   que la veas con calma?"_
3. **Branch:**
   - **Sí** → tool `send_whatsapp_optin` → _"Listo, te llega un mensajito ahorita.
     Ábrelo y platicamos por ahí. ¡Gracias!"_ → `end_call`
   - **Dudoso / pregunta** → one RAG-answered sentence → re-offer the WhatsApp info.
   - **No / molesto** → _"Sin problema, que tengas excelente día"_ → `declined`;
     if _"no me llames"_ → `dnc` permanent.
4. Hard stop: no pitching, no price talk on the phone. That's the bot/human's job.

**New tool registered on the agent** (uses pipesong's HTTP-tool mechanism):

```
send_whatsapp_optin(prospect_id)
  → orchestrator endpoint
  → sends transactional SMS w/ wa.me link
  → marks optin_sent
```

---

## 5. Data model (additions on pipesong's Postgres)

```sql
prospect(id, name, colonia, phone_e164, ig_handle, source, state,
         attempts, last_attempt_at, next_eligible_at, crm_lead_id)
call_attempt(id, prospect_id, campaign_id, pipesong_call_id, disposition,
             duration_s, transcript_ref, recording_ref, optin_sent bool)
dnc(phone_e164 PRIMARY KEY, reason, created_at)        -- permanent suppression
campaign(id, name, agent_id, window_cfg, pacing_cfg, status)
```

Existing `agents / calls / transcripts / call_latency` stay pipesong's; the
orchestrator joins on `pipesong_call_id`.

---

## 6. Compliance-by-design — the voice "ban-averse inversion"

Built _before_ scale, not after (the gilda-outreach lesson). Voice has no ban, but
it has answer-rate decay + complaints + legal hours — same idea:

- **Call window** enforced (no calls outside salon hours / Sundays).
- **DNC permanent + instant** — any _"no me llames"_ → suppressed forever, across
  campaigns.
- **Frequency cap** — max 2 attempts/prospect, backoff, never re-dial a `declined`.
- **Disclosure** — native (recorded-call consent).
- **Answer-rate monitor = the "ban-watch" analog** — a _real_ scheduled health check
  (built + verified, not a directive-only stub): if answer-rate craters or VM-rate
  spikes → auto-throttle + alert. Kill-switch: `CAMPAIGN_ENABLED=false`.
- **Caller-ID hygiene** — consistent MX local DID, small rotating pool, monitored.

---

## 7. MX telephony + cost (rough — to validate, not quote)

- Today's pipesong DID is **US (+1267)** → calling MX salones from it = low answer +
  spam-flag. **Get MX local DID(s) on Telnyx**, match area code where feasible.
- Cost intuition at ~5k dials: Telnyx MX origination + Deepgram (~$0.004/min) + local
  GPU amortized. Connected calls ~60–90 s. Dominant cost = GPU concurrency hours,
  which we control. Likely well under the <$0.03/min pipesong target — far below a
  human SDR.
- The metric that matters: **CPQL** = total cost ÷ (qualified → inbound-WA leads).
  Read from the CRM; scale only after it beats SMS/ads in a parallel test.

---

## 8. Phased build (wedge-first)

1. **P1 — MX number + 1 agent + handoff tool.** Salon-opener agent on an MX DID;
   wire `send_whatsapp_optin` → SMS `wa.me`. Manual single calls, end-to-end.
2. **P2 — Orchestrator MVP.** State machine + pacing + DNC + window + webhook→CRM.
   Dial **the existing ~296 Iztapalapa list** (already validated, in hand) as pilot.
3. **P3 — Instrument + read CPQL.** Connect-rate, qualify-rate, SMS-click-rate,
   inbound-WA-rate, won. Tune script + windows.
4. **P4 — Scale to CDMX 23k** only if CPQL clears the bar: more GPU concurrency, MX
   DID pool, Grafana (pipesong Phase 5), load test (Phase 6).

---

## Open questions

- **GPU** — earmarked, or a procurement step? (Caps call concurrency = scale ceiling.)
- **One Telnyx account for voice + bridge SMS, or split vendors?**
- **Orchestrator as its own service, or folded into the (currently-wiped) agentic-CRM?**
- **SMS provider** — Telnyx MX SMS (one vendor for voice+SMS) is cleanest; confirm.
- **Handoff target** — the brand/product WhatsApp number (inbound) — confirm which.
