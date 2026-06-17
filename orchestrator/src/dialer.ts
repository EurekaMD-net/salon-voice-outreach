import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { Config } from "./config.js";
import type { PipesongClient } from "./pipesong-client.js";
import type { Disposition } from "./types.js";
import {
  canDial,
  freeConcurrencySlots,
  isCampaignEnabled,
  isWithinWindow,
} from "./guardrails.js";
import { applyDisposition } from "./state-machine.js";

export interface Campaign {
  id: string;
  /** pipesong agent id (the salon-opener) used for origination. */
  agentId: string;
}

export interface TickResult {
  dialed: number;
  /** Why no calls were placed (when dialed === 0), else null. */
  reason: string | null;
}

interface EligibleRow {
  id: string;
  phone_e164: string;
  name: string | null;
  colonia: string | null;
  attempts: number;
}

/**
 * Apply a finished call's disposition to the PROSPECT (state machine). Re-queue
 * writes `next_eligible_at` via SQL `datetime('now', '+Nh')` — canonical format
 * (QA M2: never JS `toISOString()`, which breaks lexical ordering on the TEXT
 * column). Reusable: the dialer's origination-failure path and the (later)
 * webhook handler both call this.
 */
export function recordDisposition(
  db: DB,
  cfg: Config,
  prospectId: string,
  disposition: Disposition,
): void {
  const row = db
    .prepare("SELECT attempts FROM prospect WHERE id = ?")
    .get(prospectId) as { attempts: number } | undefined;
  if (!row) return;
  const outcome = applyDisposition(disposition, row.attempts, cfg.maxAttempts);
  if (outcome.requeue) {
    db.prepare(
      "UPDATE prospect SET state = 'queued', next_eligible_at = datetime('now', ?) WHERE id = ?",
    ).run(`+${cfg.retryBackoffHours} hours`, prospectId);
  } else {
    db.prepare("UPDATE prospect SET state = ? WHERE id = ?").run(
      outcome.nextState,
      prospectId,
    );
  }
}

/**
 * Reaper (QA W1): a prospect stuck in `dialing` past `stuckDialingMinutes` means
 * no webhook ever arrived (pipesong crash / dropped webhook). Left alone it
 * permanently consumes a concurrency slot → silent dialer stall. Resolve each as
 * a `failed` attempt (→ requeue under cap, else exhausted), freeing the slot.
 * `tick()` runs this before computing slots. Returns the number reaped.
 */
export function sweepStuckDialing(db: DB, cfg: Config): number {
  const stuck = db
    .prepare(
      `SELECT id FROM prospect
        WHERE state = 'dialing'
          AND last_attempt_at IS NOT NULL
          AND last_attempt_at < datetime('now', ?)`,
    )
    .all(`-${cfg.stuckDialingMinutes} minutes`) as { id: string }[];
  for (const p of stuck) recordDisposition(db, cfg, p.id, "failed");
  return stuck.length;
}

/**
 * One pacing-loop iteration. Global gates first (kill-switch → window →
 * concurrency budget), then select eligible prospects and dial up to the free
 * slots. The eligibility SELECT enforces `next_eligible_at <= now` (QA forward-
 * flag) and excludes DNC; `canDial()` re-checks per-prospect gates as defense in
 * depth. The `WHERE state='queued'` claim makes each dial idempotent under races.
 */
export async function tick(
  db: DB,
  cfg: Config,
  client: PipesongClient,
  campaign: Campaign,
  now: Date,
): Promise<TickResult> {
  if (!isCampaignEnabled(cfg))
    return { dialed: 0, reason: "campaign_disabled" };
  if (!isWithinWindow(now, cfg)) return { dialed: 0, reason: "outside_window" };

  // Return any leaked `dialing` slots to the pool before budgeting (QA W1).
  sweepStuckDialing(db, cfg);

  // CONCURRENCY-CAP INVARIANT (QA R1): the path from this slot read to the first
  // synchronous claim UPDATE below must contain NO `await`. better-sqlite3 is
  // synchronous, so each claim commits before `await originateCall` yields the
  // event loop — that's what lets interleaved tick() runs stay within the cap. If
  // anyone inserts an await here (async DB driver, pre-claim async lookup), the
  // cap races via TOCTOU. Keep it synchronous.
  const slots = freeConcurrencySlots(db, cfg);
  if (slots <= 0) return { dialed: 0, reason: "no_slots" };

  const rows = db
    .prepare(
      `SELECT id, phone_e164, name, colonia, attempts
         FROM prospect
        WHERE state = 'queued'
          AND next_eligible_at <= datetime('now')
          AND attempts < ?
          AND phone_e164 NOT IN (SELECT phone_e164 FROM dnc)
        ORDER BY next_eligible_at ASC, created_at ASC
        LIMIT ?`,
    )
    .all(cfg.maxAttempts, slots) as EligibleRow[];

  let dialed = 0;
  for (const p of rows) {
    const decision = canDial(
      db,
      cfg,
      { phone_e164: p.phone_e164, attempts: p.attempts },
      now,
    );
    if (!decision.ok) continue;

    // Claim queued → dialing (+1 attempt). The state guard makes a double-claim a
    // no-op, so a concurrent tick can't dial the same prospect twice.
    const claim = db
      .prepare(
        "UPDATE prospect SET state = 'dialing', attempts = attempts + 1, last_attempt_at = datetime('now') WHERE id = ? AND state = 'queued'",
      )
      .run(p.id);
    if (claim.changes === 0) continue;

    const callAttemptId = randomUUID();
    let callId: string | null = null;
    let failed = false;
    try {
      const res = await client.originateCall({
        agentId: campaign.agentId,
        toNumber: p.phone_e164,
        variables: { nombre: p.name ?? "", colonia: p.colonia ?? "" },
      });
      callId = res.callId;
    } catch {
      failed = true;
    }

    db.prepare(
      "INSERT INTO call_attempt (id, prospect_id, campaign_id, pipesong_call_id, disposition) VALUES (?, ?, ?, ?, ?)",
    ).run(callAttemptId, p.id, campaign.id, callId, failed ? "failed" : null);

    if (failed) {
      // No call started → no webhook will arrive. Resolve immediately (retry/exhaust).
      recordDisposition(db, cfg, p.id, "failed");
    }
    dialed += 1;
  }

  return { dialed, reason: dialed === 0 ? "no_eligible" : null };
}
