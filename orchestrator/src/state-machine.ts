/**
 * The prospect state machine (SPEC §3), post-call half. Pure — no DB, no clock —
 * so it's exhaustively testable. Given a call's final disposition and the attempt
 * count *already made*, decide the prospect's next state and whether to re-queue.
 *
 * The dialer increments `attempts` at dial time, so `attempts` here is the number
 * of calls already placed. With maxAttempts=2: 1st call → attempts=1, a no-answer
 * re-queues (1<2); 2nd call → attempts=2, a no-answer exhausts (2<2 is false).
 *
 * Handoff-side transitions (qualified → optin_sent → inbound_received → won/lost)
 * are the handoff increment's concern, not the dialer's.
 */
import type { Disposition, ProspectState } from "./types.js";

export interface DispositionOutcome {
  /** Prospect state to move to when NOT re-queuing. */
  nextState: ProspectState;
  /** If true, the dialer re-queues (`state='queued'` + backoff on next_eligible_at). */
  requeue: boolean;
}

/** Dispositions that earn a retry (transient / not the prospect's choice). */
const RETRYABLE: ReadonlySet<Disposition> = new Set<Disposition>([
  "no_answer",
  "voicemail",
  "failed",
]);

/**
 * Map a call disposition → the prospect's next state.
 * - qualified/declined/dnc → terminal-for-the-dialer (handoff or done).
 * - connected with no resolution → stays `connected` (a webhook resolves it; rare).
 * - no_answer/voicemail/failed → re-queue with backoff while under the cap, else exhausted.
 */
export function applyDisposition(
  disposition: Disposition,
  attempts: number,
  maxAttempts: number,
): DispositionOutcome {
  switch (disposition) {
    case "qualified":
      return { nextState: "qualified", requeue: false };
    case "declined":
      return { nextState: "declined", requeue: false };
    case "dnc":
      return { nextState: "dnc", requeue: false };
    case "connected":
      // Connected but unresolved (no optin / no decline yet) — leave it for the
      // webhook handler to resolve. Not re-queued, not terminal.
      return { nextState: "connected", requeue: false };
    case "no_answer":
    case "voicemail":
    case "failed":
      return attempts < maxAttempts
        ? { nextState: "queued", requeue: true }
        : { nextState: "exhausted", requeue: false };
    default: {
      // Exhaustiveness guard: a new Disposition must be handled explicitly.
      const _never: never = disposition;
      throw new Error(`unhandled disposition: ${String(_never)}`);
    }
  }
}

export { RETRYABLE };
