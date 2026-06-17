import type { PipelineStage } from "./types.js";

/**
 * Pipeline-stage logic. Stage advancement is FORWARD-ONLY and monotonic: a lead
 * never regresses (a later, lower-rank event can't pull it back), and `won`/`lost`
 * are terminal (no automatic transition out of them).
 *
 * This is the only place stage transitions are decided, so later increments
 * (handoff, inbound engagement, won/lost) extend the map below, not the callers.
 */

const STAGE_RANK: Record<PipelineStage, number> = {
  new: 0,
  contacted: 1,
  qualified: 2,
  handed_off: 3,
  engaged_inbound: 4,
  won: 5,
  lost: 5,
};

const TERMINAL: ReadonlySet<PipelineStage> = new Set<PipelineStage>([
  "won",
  "lost",
]);

/**
 * Return the resulting stage after observing `target`. Never moves backward;
 * once terminal, stays put. `won` vs `lost` (equal rank) never auto-swap.
 */
export function advanceStage(
  current: PipelineStage,
  target: PipelineStage,
): PipelineStage {
  if (TERMINAL.has(current)) return current;
  return STAGE_RANK[target] > STAGE_RANK[current] ? target : current;
}

/**
 * The minimum stage a given event type implies. `null` = this event type does not
 * itself move the stage (e.g. a free-text note). A present qualification always
 * implies `qualified` regardless of type — the caller ORs that in.
 */
export function impliedStage(eventType: string): PipelineStage | null {
  switch (eventType) {
    case "referral": // logged referral, not yet contacted
      return "new";
    case "manual_intake": // a human captured them via the sales phone
    case "call":
    case "contacted":
      return "contacted";
    case "qualified":
      return "qualified";
    case "optin_sent":
    case "handed_off":
      return "handed_off";
    case "inbound":
    case "inbound_msg":
    case "engaged_inbound":
      return "engaged_inbound";
    case "won":
      return "won";
    case "lost":
      return "lost";
    default:
      return null;
  }
}
