/** Domain types for vlcrm (Stage 1). Column shapes mirror schema.ts exactly. */

/** Where an account sits in the funnel. Forward-only; won/lost terminal. */
export type PipelineStage =
  | "new"
  | "contacted"
  | "qualified"
  | "handed_off"
  | "engaged_inbound"
  | "won"
  | "lost";

/** Acquisition channel the account first entered through (set-once provenance). */
export type AccountSource =
  | "denue"
  | "sales_phone"
  | "web"
  | "referral"
  | "import"
  | "other";

/** Channel a single interaction happened on. */
export type Channel = "voice" | "sms" | "whatsapp" | "sales_phone" | "other";

export type Direction = "inbound" | "outbound";

export interface Account {
  id: string;
  account_key: string;
  name: string | null;
  pipeline_stage: PipelineStage;
  source: AccountSource;
  referred_by_account_id: string | null;
  referred_by_name: string | null;
  referred_by_phone: string | null;
  /** stored as 0/1 */
  dnc: number;
  consent_at: string | null;
  /** vertical specifics as JSON text */
  attributes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  account_id: string;
  name: string | null;
  role: string | null;
  phone_e164: string | null;
  email: string | null;
  ig_handle: string | null;
  /** stored as 0/1 */
  whatsapp_optin: number;
  created_at: string;
  updated_at: string;
}

export interface Interaction {
  id: string;
  account_id: string;
  contact_id: string | null;
  channel: Channel;
  direction: Direction;
  type: string;
  outcome: string | null;
  cost_cents: number;
  ref_id: string | null;
  payload: string | null;
  occurred_at: string;
  created_at: string;
}

export interface Qualification {
  id: string;
  account_id: string;
  /** 0/1/null */
  interested: number | null;
  fit: string | null;
  objection: string | null;
  callback_window: string | null;
  score: number | null;
  source_interaction_id: string | null;
  captured_at: string;
}
