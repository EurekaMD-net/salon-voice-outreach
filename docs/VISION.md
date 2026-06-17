# Vision — where the value is, and the order we build it

**The north-star doc.** `ARCHITECTURE.md` is _how_ the system works; `PIPESONG-NOTES.md`
is the engine's _reality_; this is _why_ it's defensible and _what we build first_.

---

## 1. The thesis — the moat is our data, not our tech

pipesong on its bare bones is **nothing special** — anyone can wire Pipecat +
Deepgram + a local LLM + a TTS. That layer is **rented commodity**. The proprietary
value is everything we stack on top, and the only layer that _compounds_ is the
**feedback loop**: nobody else has months of **labeled Mexican-salon-owner
conversation outcomes**. Every call we place turns into an asset competitors can't
buy or copy.

> Design rule that follows from this: **everything we build exists to feed the
> feedback loop (L4) faster, and the loop's data capture must be wired before the
> first call.** You cannot retrofit the moat — uncaptured calls are lost forever.

---

## 2. The stack — 6 layers (commodity at the bottom, compounding asset at the top)

```
   value &        ┌────────────────────────────────────────────────────────┐
defensibility     │ L5  COMPOUNDING ASSET    book of salons · referral ·    │ ← the output
      ▲           │                          "powered by Gilda" · brand     │
      │           ├────────────────────────────────────────────────────────┤
      │           │ L4  FEEDBACK LOOP  ★THE MOAT★   call→outcome→learning   │ ← proprietary,
      │           │                          recirculated into L1+L2+L3     │   compounds
      │           ├────────────────────────────────────────────────────────┤
      │           │ L3  CONVERSATION INTEL   scripts · qualify · objections │ ← becomes
      │           │                          · RAG · (tuned on L4 corpus)   │   proprietary
      │           ├────────────────────────────────────────────────────────┤   once fed by L4
      │           │ L2  ORCHESTRATION        who/when · pacing · compliance │ ← operational
      │           │  (the nervous system)    · multi-channel · handoff      │   know-how
      │           ├────────────────────────────────────────────────────────┤
      │           │ L1  DATA SPINE           prospect graph · enrichment ·  │ ← raw material
      │           │  (the raw material)      DNC · per-prospect state       │
      │           ├────────────────────────────────────────────────────────┤
      │           │ L0  COMMODITY SUBSTRATE  pipesong · Telnyx · Deepgram · │ ← NOT the moat,
                  │  (rentable, swappable)   GPU · SMS                       │   interchangeable
                  └────────────────────────────────────────────────────────┘
```

| Layer                     | What                                                                                  | Why it matters                                                        | How it's built                                             | Moat?             |
| ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------- |
| **L0 Substrate**          | Voice/telephony/STT/GPU/SMS                                                           | You need a dial-tone                                                  | Rent (pipesong, Telnyx, Deepgram)                          | ❌ swappable      |
| **L1 Spine**              | Prospect graph: 23k salons + enrichment + state + DNC                                 | Can't act on who you can't see                                        | DENUE → validate/dedupe → enrich (IG, web) → state machine | 🟡 partly         |
| **L2 Orchestration**      | Who/when to call, pacing, compliance, channel-sequencing, handoff                     | Turns a list into governed action; keeps WA inbound                   | The campaign engine (main build)                           | 🟡 know-how       |
| **L3 Conversation intel** | Script, qualification, objection-handling, RAG                                        | A generic agent gets ~2%; a _tuned_ one gets ~10%                     | Prompt + linear flow v0 → **tuned on L4 corpus**           | ✅ once fed by L4 |
| **L4 Feedback loop**      | call → transcript + disposition + conversion → attribution → recirculated to L1/L2/L3 | **The moat.** Labeled outcome data nobody else has, compounding daily | Outcome capture + analysis + recirculation wiring          | ✅✅ **the moat** |
| **L5 Asset**              | Salons signed, the WA book, referral/virality, brand                                  | The compounding business outcome                                      | Emerges when L4 runs                                       | ✅ network effect |

**Sharp version:** L0 is rented, L1–L2 are smart plumbing, **L3+L4 are the IP — and
L4 is the only layer that compounds.**

---

## 3. How it threads — two flows, one loop

```
  DOWNWARD: INTENT compiles into action          UPWARD: REALITY compiles into learning
  ───────────────────────────────────           ──────────────────────────────────────
  L5  "sign N salons in segment X"               L5  signed / churned  ▲
       │ defines the target                          ▲ proves what works │
       ▼                                              │                   │
  L4  targeting policy + best script  ───────────▶ L4  CPQL, conversion, objection mining
       │ picks who + what to say                      ▲ labels every outcome
       ▼                                              │
  L3  the agent says the right thing             L3  transcript (what was said)
       ▼                                              ▲
  L2  dials the right prospect, right time       L2  disposition (answered? qualified?)
       ▼                                              ▲
  L1  selects an eligible prospect               L1  state updated, graph enriched
       ▼                                              ▲
  L0  places the call                       ───▶ L0  raw call audio/events
```

- **Intent flows down** and compiles into a dialed call.
- **Reality flows up** as data and compiles into learning at L4.
- **L4 recirculates down** as better targeting (L1), pacing (L2), and scripts (L3).
  **That recirculation is the flywheel.** A competitor cloning L0–L3 on day 1 starts
  the loop at zero; we are N months of labeled calls ahead, and the gap widens daily.

**Non-negotiable (the #1 lesson from the WhatsApp burn):** if L4 capture isn't wired
before call #1, that call's data is lost forever. **Capture comes first, not last.**

---

## 4. Three stages of scaffolding — what to build, in order

Ordering principle, grounded in everything learned: **don't scale a funnel you
haven't proven; don't build the learning loop before you have data to learn from;
but wire capture + guardrails from call #1 so nothing is lost and nothing gets
banned.** Wedge → loop → scale. (This reframes `ARCHITECTURE.md §8`'s P1–P4:
Stage 1 ≈ P1+P2+P3, Stage 3 ≈ P4; Stage 2 is the explicit moat layer.)

### Stage 1 — THE PIPE _(prove one closed loop, instrumented & guarded)_

- **What:** the thinnest _vertical_ slice — one real prospect → real call → qualified
  → SMS `wa.me` → inbound WA → outcome recorded. Lights up L0–L3 thinly **plus L4's
  capture hooks** and the compliance skeleton.
- **Why:** prove the funnel converts _at all_ and get a baseline CPQL before spending
  on scale; establish the schema so every call from #1 feeds the future moat.
- **How:** MX DID + linear salon-opener agent (1 tool: `send_whatsapp_optin`) +
  orchestrator MVP (state machine, window, DNC, concurrency cap, retry) +
  webhook→outcome→CRM capture + **guardrails, answer-rate monitor & `CAMPAIGN_ENABLED`
  kill-switch on day 1** (gilda lesson: build it right, and _verify the path actually
  fires_ — no directive-only stubs). **Wedge = the preserved 296 Iztapalapa list.**
- **First move inside Stage 1:** the **outcome schema + guardrails skeleton**, _then_
  the call+handoff, _then_ the pacing loop. Capture and safety before volume.

### Stage 2 — THE LOOP _(make every call teach the system — the proprietary stage)_

- **What:** build L4 for real. Transcript + disposition + conversion → attribution by
  segment/colonia/time/script; objection-mining → a segmented script library + a
  qualification signal; recirculate into L1 (who to call next) and L3 (what to say).
- **Why:** where commodity becomes moat. After Stage 1 there's data; now turn it into
  compounding advantage. CPQL stops being a number you read and becomes one you drive.
- **How:** analysis pipeline over the call corpus + recirculation wiring (targeting
  policy fed by outcomes; A/B'd script variants; qualification model). Volume: a few
  hundred → low thousands.

### Stage 3 — THE FLYWHEEL AT SCALE _(scale on proven CPQL + compounding data)_

- **What:** scale to 23k and light up L5. Add the parallel channels (SMS, Meta
  Custom-Audience ads) the CPQL data now justifies; tune L3 on our transcript corpus
  (RAG → eventually fine-tune); close the loop to product (what salons ask for →
  roadmap) and growth (referral, "powered by Gilda" virality).
- **Why:** scaling is only safe _after_ the loop proves unit economics — paid
  acquisition with no proof burns money; scaling a leaky funnel burns numbers.
- **How:** GPU concurrency expansion (~30/RTX-4090 ceiling), MX DID pool,
  Grafana/monitoring + load test (pipesong Phases 5/6), multi-channel orchestration,
  data corpus driving targeting + scripts + conversion prediction.

---

## 5. What comes first

**Stage 1 — and its first artifact is the L4 capture schema + the compliance/monitoring
skeleton, built before the first dial.** Then the linear call + handoff, then the
orchestrator pacing loop, run against the 296. The `§3 orchestrator spec` is built
around this **capture-first** principle: outcome-capture schema and guardrails are its
spine, not an afterthought.

---

**See also:** [`ARCHITECTURE.md`](ARCHITECTURE.md) (system design) ·
[`PIPESONG-NOTES.md`](PIPESONG-NOTES.md) (engine contract + constraints + gaps).
