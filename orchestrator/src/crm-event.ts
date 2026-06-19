import type { Config } from "./config.js";
import type { Disposition } from "./types.js";

/**
 * CrmLeadEvent — the orchestrator's view of vlcrm's `LeadEvent` wire contract.
 * Deliberately a LOCAL type (not imported from the vlcrm package): each side of a
 * service boundary owns its serialization, and vlcrm's `validateLeadEvent` is the
 * single enforcement point. We emit only the subset a voice dialer produces.
 */
export interface CrmLeadEvent {
  accountKey: string;
  channel: "voice";
  direction: "outbound";
  type: string;
  source?: string;
  name?: string;
  contact?: {
    name?: string;
    phone?: string;
    ig?: string;
  };
  outcome?: string;
  costCents?: number;
  refId?: string;
  payload?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  qualification?: { interested?: boolean };
  /** do-not-contact: set when the call outcome was `dnc`; vlcrm latches account.dnc=1. */
  dnc?: boolean;
}

/** A finalized call_attempt joined with its prospect — the outbox row shape. */
export interface CrmSyncRow {
  call_attempt_id: string;
  campaign_id: string;
  pipesong_call_id: string | null;
  disposition: Disposition;
  duration_s: number | null;
  phone_e164: string;
  name: string | null;
  colonia: string | null;
  ig_handle: string | null;
  source: string;
}

/**
 * Map one disposition to its CRM event type + outcome (+ qualification). The
 * coarse vlcrm stage is driven by `type`:
 *   - human reached / opted in → `call` (advances to "contacted")
 *   - do-not-contact          → `dnc` (NO stage advance; sets event.dnc → account.dnc=1
 *     at vlcrm, so a suppressed prospect never sits in the active pipeline)
 *   - qualified               → `qualified` (+ interested:true → "qualified")
 *   - no human (no_answer/voicemail/failed) → `call_attempt` (logged, NO stage
 *     advance — we never reached them; CPQL must not count these as contact)
 * The full fidelity (which disposition) always lives in `outcome`.
 */
function dispositionToType(d: Disposition): {
  type: string;
  interested?: boolean;
} {
  switch (d) {
    case "qualified":
      return { type: "qualified", interested: true };
    case "connected":
    case "declined":
      return { type: "call" };
    case "dnc":
      return { type: "dnc" };
    case "no_answer":
    case "voicemail":
    case "failed":
      return { type: "call_attempt" };
  }
}

/**
 * Cost of a voice call in cents: whole minutes (rounded up) × the per-minute
 * rate. `duration_s` is populated by the webhook handler (not yet built), so
 * today most attempts cost 0 — cost fills in once durations flow. Never
 * negative: a missing/zero duration yields 0.
 */
export function callCostCents(durationS: number | null, cfg: Config): number {
  if (!durationS || durationS <= 0) return 0;
  return Math.ceil(durationS / 60) * cfg.voiceCostPerMinuteCents;
}

/**
 * Build the CRM lead event for a finalized call attempt. Pure (no DB / no IO):
 * the outbox pump selects rows, this shapes them, the client emits them.
 *
 * - accountKey = the prospect's E.164 phone (already canonical at import — the
 *   same dedup key vlcrm derives from a sales-phone intake).
 * - `source` collapses the campaign-specific list tag (e.g. "denue-iztapalapa-…")
 *   to vlcrm's enum value "denue"; anything non-DENUE → "other".
 * - colonia → `attributes` (account vertical bag); campaign/call ids → `payload`
 *   (interaction-level provenance). refId = the call_attempt id (traceable, and
 *   the future idempotency key for exactly-once).
 */
export function buildCrmEvent(row: CrmSyncRow, cfg: Config): CrmLeadEvent {
  const { type, interested } = dispositionToType(row.disposition);
  const event: CrmLeadEvent = {
    accountKey: row.phone_e164,
    channel: "voice",
    direction: "outbound",
    type,
    source: row.source.startsWith("denue") ? "denue" : "other",
    outcome: row.disposition,
    costCents: callCostCents(row.duration_s, cfg),
    refId: row.call_attempt_id,
    payload: {
      campaignId: row.campaign_id,
      pipesongCallId: row.pipesong_call_id,
    },
  };
  if (row.name) event.name = row.name;
  const contact: CrmLeadEvent["contact"] = {};
  if (row.name) contact.name = row.name;
  contact.phone = row.phone_e164;
  if (row.ig_handle) contact.ig = row.ig_handle;
  event.contact = contact;
  if (row.colonia) event.attributes = { colonia: row.colonia };
  if (interested !== undefined) event.qualification = { interested };
  if (row.disposition === "dnc") event.dnc = true;
  return event;
}
