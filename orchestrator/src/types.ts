/** Domain types for the outreach orchestrator (Stage 1). */

/** Per-prospect lifecycle state. See SPEC §3 (state machine). */
export type ProspectState =
  | "queued"
  | "dialing"
  | "no_answer"
  | "voicemail"
  | "connected"
  | "qualified"
  | "declined"
  | "dnc"
  | "optin_sent"
  | "inbound_received"
  | "won"
  | "lost"
  | "exhausted"
  | "invalid";

/** Outcome of a single call attempt (derived from the pipesong webhook + tool fires). */
export type Disposition =
  | "no_answer"
  | "voicemail"
  | "connected"
  | "qualified"
  | "declined"
  | "dnc"
  | "failed";

export type CampaignStatus = "paused" | "active" | "stopped";

export interface Prospect {
  id: string;
  name: string | null;
  colonia: string | null;
  phone_e164: string;
  ig_handle: string | null;
  source: string;
  state: ProspectState;
  attempts: number;
  last_attempt_at: string | null;
  next_eligible_at: string;
  crm_lead_id: string | null;
  created_at: string;
}

export interface CallAttempt {
  id: string;
  prospect_id: string;
  campaign_id: string;
  pipesong_call_id: string | null;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  disposition: Disposition | null;
  /** stored as 0/1 in SQLite */
  optin_sent: number;
  transcript_ref: string | null;
  recording_ref: string | null;
  /** full webhook payload as JSON text — the Stage-2 mining corpus */
  raw: string | null;
}
