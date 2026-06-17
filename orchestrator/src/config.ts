/**
 * Config + the campaign kill-switch. CAMPAIGN_ENABLED defaults to FALSE — the
 * dialer never runs unless explicitly turned on (the gilda lesson: safe by
 * default, build the guardrails before the volume).
 */

export interface WindowCfg {
  /** Allowed weekdays, 0=Sun … 6=Sat. Default Mon–Sat. */
  days: number[];
  /** Inclusive local start hour (0–23). */
  startHour: number;
  /** Exclusive local end hour (1–24). */
  endHour: number;
}

export interface Config {
  /** Master kill-switch. Dialer is a no-op unless this is true. */
  campaignEnabled: boolean;
  /** IANA tz the window is evaluated in. */
  timezone: string;
  window: WindowCfg;
  /** Max simultaneous live calls (Stage 1 pilot: bounded by the shared 4090). */
  maxConcurrentCalls: number;
  /** Per-prospect attempt cap. */
  maxAttempts: number;
  /** Backoff before re-queueing a no_answer/voicemail. */
  retryBackoffHours: number;
  /** Below this rolling answer-rate the monitor auto-pauses + alerts. */
  answerRateFloor: number;
  /** SQLite path. */
  dbPath: string;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

/** Parse "1-6" / "1,2,3" / "0-6" into a weekday list (0=Sun…6=Sat). */
export function parseDays(raw: string | undefined, dflt: number[]): number[] {
  if (!raw || raw.trim() === "") return dflt;
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const seg = part.trim();
    if (seg.includes("-")) {
      const [a, b] = seg.split("-").map((x) => parseInt(x, 10));
      if (Number.isInteger(a) && Number.isInteger(b)) {
        for (let d = a!; d <= b!; d++) if (d >= 0 && d <= 6) out.add(d);
      }
    } else {
      const d = parseInt(seg, 10);
      if (Number.isInteger(d) && d >= 0 && d <= 6) out.add(d);
    }
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : dflt;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const startHour = intEnv(env, "WINDOW_START_HOUR", 10);
  let endHour = intEnv(env, "WINDOW_END_HOUR", 19);
  // Guard against an inverted/degenerate window → fall back to defaults.
  if (endHour <= startHour) endHour = 19;
  return {
    campaignEnabled: env["CAMPAIGN_ENABLED"] === "true",
    timezone: env["TZ_OUTREACH"] ?? "America/Mexico_City",
    window: {
      days: parseDays(env["WINDOW_DAYS"], [1, 2, 3, 4, 5, 6]), // Mon–Sat
      startHour,
      endHour,
    },
    maxConcurrentCalls: intEnv(env, "MAX_CONCURRENT_CALLS", 3),
    maxAttempts: intEnv(env, "MAX_ATTEMPTS", 2),
    retryBackoffHours: intEnv(env, "RETRY_BACKOFF_HOURS", 24),
    answerRateFloor: Number(env["ANSWER_RATE_FLOOR"] ?? "0.10"),
    dbPath: env["ORCHESTRATOR_DB"] ?? "./data/orchestrator.db",
  };
}
