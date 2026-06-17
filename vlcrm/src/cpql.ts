import type { DB } from "./db.js";

/**
 * CPQL rollup — **Cost Per Qualified Lead**, the one number the venture
 * optimizes, plus the two breakdowns that explain it.
 *
 * Definitions (kept deliberately simple + defensible for v1):
 *   - costCents  = total spend across ALL interactions (cost lives on the
 *                  interaction row, so this is just SUM).
 *   - qualified  = distinct accounts with an explicit qualification verdict of
 *                  `interested = 1`. We use the qualification table, NOT the coarse
 *                  pipeline_stage, so the headline is independent of stage
 *                  semantics (a no-answer that advanced to "contacted" never
 *                  inflates the denominator).
 *   - cpqlCents  = costCents / qualified, rounded; null when qualified = 0 (no
 *                  division-by-zero, and "∞ / undefined" is reported honestly).
 *
 * NOT a contested attribution model: `costByChannel` shows where spend went;
 * `qualifiedBySource` shows which acquisition channel produced qualified leads.
 * Per-channel CPQL (which channel gets credit for a given qualification) is a
 * later refinement.
 */
export interface CpqlReport {
  overall: {
    leads: number;
    qualified: number;
    costCents: number;
    cpqlCents: number | null;
  };
  costByChannel: { channel: string; costCents: number; interactions: number }[];
  qualifiedBySource: { source: string; qualified: number }[];
}

export function computeCpql(db: DB): CpqlReport {
  const leads = (
    db.prepare("SELECT COUNT(*) AS n FROM account").get() as {
      n: number;
    }
  ).n;

  const qualified = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT account_id) AS n FROM qualification WHERE interested = 1",
      )
      .get() as { n: number }
  ).n;

  // QA R1: SUM assumes once-only delivery. The orchestrator's outbox is
  // at-least-once (a crash between emit and mark re-emits → a duplicate
  // interaction would double-count here). refId = call_attempt id is carried for
  // a future vlcrm-side exactly-once dedup; until then this is a known caveat.
  const costCents = (
    db
      .prepare("SELECT COALESCE(SUM(cost_cents), 0) AS c FROM interaction")
      .get() as { c: number }
  ).c;

  const cpqlCents = qualified > 0 ? Math.round(costCents / qualified) : null;

  const costByChannel = db
    .prepare(
      `SELECT channel,
              COALESCE(SUM(cost_cents), 0) AS costCents,
              COUNT(*) AS interactions
         FROM interaction
        GROUP BY channel
        ORDER BY channel`,
    )
    .all() as { channel: string; costCents: number; interactions: number }[];

  const qualifiedBySource = db
    .prepare(
      `SELECT a.source AS source,
              COUNT(DISTINCT q.account_id) AS qualified
         FROM qualification q
         JOIN account a ON a.id = q.account_id
        WHERE q.interested = 1
        GROUP BY a.source
        ORDER BY a.source`,
    )
    .all() as { source: string; qualified: number }[];

  return {
    overall: { leads, qualified, costCents, cpqlCents },
    costByChannel,
    qualifiedBySource,
  };
}
