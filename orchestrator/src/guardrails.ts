/**
 * Compliance guardrails — the "ban-averse inversion" for voice, built BEFORE the
 * dialer (SPEC §8). Voice has no ban, but answer-rate decay, complaints, and legal
 * hours are the analog. Every gate here is pure or a simple DB read, so it's fully
 * testable without placing a call.
 *
 * Order of gates in canDial(): kill-switch → window → DNC → frequency cap.
 */
import type { Config } from "./config.js";
import type { DB } from "./db.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Local wall-clock parts for `date` in the configured timezone (not the VPS's UTC). */
export function localParts(
  date: Date,
  timezone: string,
): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hourRaw = parts.find((p) => p.type === "hour")?.value ?? "0";
  // hour12:false can emit "24" at midnight in some ICU builds → normalize to 0.
  const hour = parseInt(hourRaw, 10) % 24;
  const weekday = WEEKDAYS.indexOf(wd as (typeof WEEKDAYS)[number]);
  return { hour, weekday: weekday < 0 ? 0 : weekday };
}

/** True only if the master kill-switch is on. */
export function isCampaignEnabled(cfg: Config): boolean {
  return cfg.campaignEnabled;
}

/** True if `date` (in cfg.timezone) is inside the allowed send window. */
export function isWithinWindow(date: Date, cfg: Config): boolean {
  const { hour, weekday } = localParts(date, cfg.timezone);
  return (
    cfg.window.days.includes(weekday) &&
    hour >= cfg.window.startHour &&
    hour < cfg.window.endHour
  );
}

/** True if the number is on the permanent do-not-call list. */
export function isDncBlocked(db: DB, phoneE164: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM dnc WHERE phone_e164 = ?")
    .get(phoneE164);
  return row !== undefined;
}

/** True while the prospect still has attempts left. */
export function underFrequencyCap(attempts: number, cfg: Config): boolean {
  return attempts < cfg.maxAttempts;
}

/** How many more calls we may place right now (cap minus live calls). */
export function freeConcurrencySlots(db: DB, cfg: Config): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM prospect WHERE state = 'dialing'")
    .get() as { n: number };
  return Math.max(0, cfg.maxConcurrentCalls - row.n);
}

export interface DialDecision {
  ok: boolean;
  reason?: string;
}

/**
 * Single chokepoint: may we dial this prospect now? Combines every gate in
 * priority order. The pacing loop calls this; nothing dials that this rejects.
 */
export function canDial(
  db: DB,
  cfg: Config,
  prospect: { phone_e164: string; attempts: number },
  now: Date,
): DialDecision {
  if (!isCampaignEnabled(cfg))
    return { ok: false, reason: "campaign_disabled" };
  if (!isWithinWindow(now, cfg)) return { ok: false, reason: "outside_window" };
  if (isDncBlocked(db, prospect.phone_e164))
    return { ok: false, reason: "dnc" };
  if (!underFrequencyCap(prospect.attempts, cfg))
    return { ok: false, reason: "frequency_cap" };
  return { ok: true };
}
