import type { AccountSource, Channel, Direction } from "./types.js";

/**
 * LeadEvent — the agnostic ingest PORT. Every channel (the orchestrator's voice
 * dialer, an operator at the sales phone, the inbound WhatsApp closer, a web form)
 * emits this one shape; vlcrm couples to it and to nothing channel-specific. Adding
 * a channel = emitting LeadEvents, never a vlcrm change (the port-isolation rule).
 */

/**
 * Who referred this lead. The referrer is EITHER a known account (give its
 * `accountKey` — resolved to an FK) OR free text (`name`/`phone`) when not in the
 * CRM yet. At least one field should be present for the referral to be useful.
 */
export interface ReferredBy {
  accountKey?: string;
  name?: string;
  phone?: string;
}

export interface LeadEventContact {
  name?: string;
  role?: string;
  phone?: string;
  email?: string;
  ig?: string;
}

export interface LeadEventQualification {
  interested?: boolean;
  fit?: string;
  objection?: string;
  callbackWindow?: string;
  score?: number;
}

export interface LeadEvent {
  /** canonical identity for upsert/dedup. REQUIRED. */
  accountKey: string;
  /** SQLite datetime() form ("YYYY-MM-DD HH:MM:SS"); defaults to now if omitted. */
  occurredAt?: string;
  channel: Channel;
  direction: Direction;
  /** known set: manual_intake|call|optin_sent|inbound|qualified|won|lost|referral|note */
  type: string;
  /** acquisition channel; only applied when the account is first created. */
  source?: AccountSource;
  /** business name (only fills a blank on an existing account; never overwrites). */
  name?: string;
  contact?: LeadEventContact;
  referredBy?: ReferredBy;
  outcome?: string;
  costCents?: number;
  refId?: string;
  payload?: unknown;
  qualification?: LeadEventQualification;
}

/** Thrown by validateLeadEvent on any invalid input — the boundary fails CLOSED. */
export class LeadEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadEventError";
  }
}

const CHANNELS: ReadonlySet<string> = new Set<Channel>([
  "voice",
  "sms",
  "whatsapp",
  "sales_phone",
  "other",
]);
const DIRECTIONS: ReadonlySet<string> = new Set<Direction>([
  "inbound",
  "outbound",
]);
const SOURCES: ReadonlySet<string> = new Set<AccountSource>([
  "denue",
  "sales_phone",
  "web",
  "referral",
  "import",
  "other",
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function reqStr(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new LeadEventError(
      `${field} is required and must be a non-empty string`,
    );
  }
  return v;
}

function optStr(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new LeadEventError(`${field} must be a string`);
  }
  return v;
}

/**
 * Validate + normalize unknown input (HTTP body, etc.) into a LeadEvent.
 * Fail-closed: throws LeadEventError on a missing/invalid required field or a bad
 * enum value — never silently coerces a bad channel/direction to a default. (The
 * orchestrator's QA gate caught fail-OPEN config bugs; the ingest boundary holds
 * the same line.)
 */
export function validateLeadEvent(input: unknown): LeadEvent {
  if (!isObj(input)) throw new LeadEventError("event must be an object");

  const accountKey = reqStr(input.accountKey, "accountKey");
  const type = reqStr(input.type, "type");

  const channel = reqStr(input.channel, "channel");
  if (!CHANNELS.has(channel)) {
    throw new LeadEventError(`invalid channel: ${channel}`);
  }
  const direction = reqStr(input.direction, "direction");
  if (!DIRECTIONS.has(direction)) {
    throw new LeadEventError(`invalid direction: ${direction}`);
  }

  const source = optStr(input.source, "source");
  if (source !== undefined && !SOURCES.has(source)) {
    throw new LeadEventError(`invalid source: ${source}`);
  }

  let costCents: number | undefined;
  if (input.costCents !== undefined && input.costCents !== null) {
    const c = input.costCents;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 0) {
      throw new LeadEventError("costCents must be a non-negative integer");
    }
    costCents = c;
  }

  const event: LeadEvent = {
    accountKey,
    channel: channel as Channel,
    direction: direction as Direction,
    type,
  };
  const occurredAt = optStr(input.occurredAt, "occurredAt");
  if (occurredAt !== undefined) event.occurredAt = occurredAt;
  if (source !== undefined) event.source = source as AccountSource;
  const name = optStr(input.name, "name");
  if (name !== undefined) event.name = name;
  if (costCents !== undefined) event.costCents = costCents;
  const refId = optStr(input.refId, "refId");
  if (refId !== undefined) event.refId = refId;
  const outcome = optStr(input.outcome, "outcome");
  if (outcome !== undefined) event.outcome = outcome;
  if (input.payload !== undefined) event.payload = input.payload;

  if (input.contact !== undefined && input.contact !== null) {
    if (!isObj(input.contact))
      throw new LeadEventError("contact must be an object");
    const c = input.contact;
    event.contact = {
      name: optStr(c.name, "contact.name"),
      role: optStr(c.role, "contact.role"),
      phone: optStr(c.phone, "contact.phone"),
      email: optStr(c.email, "contact.email"),
      ig: optStr(c.ig, "contact.ig"),
    };
  }

  if (input.referredBy !== undefined && input.referredBy !== null) {
    if (!isObj(input.referredBy)) {
      throw new LeadEventError("referredBy must be an object");
    }
    const r = input.referredBy;
    event.referredBy = {
      accountKey: optStr(r.accountKey, "referredBy.accountKey"),
      name: optStr(r.name, "referredBy.name"),
      phone: optStr(r.phone, "referredBy.phone"),
    };
  }

  if (input.qualification !== undefined && input.qualification !== null) {
    if (!isObj(input.qualification)) {
      throw new LeadEventError("qualification must be an object");
    }
    const q = input.qualification;
    if (q.interested !== undefined && typeof q.interested !== "boolean") {
      throw new LeadEventError("qualification.interested must be a boolean");
    }
    if (
      q.score !== undefined &&
      q.score !== null &&
      (typeof q.score !== "number" || !Number.isInteger(q.score))
    ) {
      // INTEGER column (schema.ts) — SQLite won't truncate a REAL, so reject floats
      // here (same rule as costCents) rather than storing a surprise REAL.
      throw new LeadEventError("qualification.score must be an integer");
    }
    event.qualification = {
      interested: q.interested as boolean | undefined,
      fit: optStr(q.fit, "qualification.fit"),
      objection: optStr(q.objection, "qualification.objection"),
      callbackWindow: optStr(q.callbackWindow, "qualification.callbackWindow"),
      score: q.score as number | undefined,
    };
  }

  return event;
}
