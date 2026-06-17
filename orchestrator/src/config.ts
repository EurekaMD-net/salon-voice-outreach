/**
 * Config + the campaign kill-switch. CAMPAIGN_ENABLED defaults to FALSE — the
 * dialer never runs unless explicitly turned on (the gilda lesson: safe by
 * default, build the guardrails before the volume).
 *
 * FAIL-CLOSED: invalid config throws at load → the service refuses to start.
 * A typo must never silently *widen* a compliance window or relax a cap
 * (QA H1/H2/M1). Absent vars fall back to safe defaults; present-but-invalid
 * vars are a hard error.
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
  /** Backoff before re-queueing a no_answer/voicemail (≥1h — never an unpaced retry). */
  retryBackoffHours: number;
  /** A prospect stuck in `dialing` longer than this is reaped (no webhook ever
   *  arrived) so it can't permanently leak a concurrency slot. */
  stuckDialingMinutes: number;
  /** Below this rolling answer-rate the monitor auto-pauses + alerts. */
  answerRateFloor: number;
  /** SQLite path. */
  dbPath: string;
}

interface NumOpts {
  min: number;
  max: number;
  /** Require an integer (default true). */
  integer?: boolean;
}

/**
 * Read a numeric env var with bounds. Absent → default. Present-but-invalid
 * (non-numeric, non-integer when required, or out of [min,max]) → throw.
 */
function numEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  dflt: number,
  { min, max, integer = true }: NumOpts,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n))
    throw new Error(`config: ${key}="${raw}" is not a number`);
  if (integer && !Number.isInteger(n))
    throw new Error(`config: ${key}="${raw}" must be an integer`);
  if (n < min || n > max)
    throw new Error(`config: ${key}=${n} out of range [${min}, ${max}]`);
  return n;
}

/**
 * Parse "1-6" / "1,2,3" / "0-6" into a weekday list (0=Sun…6=Sat).
 * Absent → default. Present-but-invalid → throw (fail-closed: a typo must not
 * silently widen the window to all days).
 */
export function parseDays(raw: string | undefined, dflt: number[]): number[] {
  if (raw === undefined || raw.trim() === "") return dflt;
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const seg = part.trim();
    if (seg === "") continue;
    if (seg.includes("-")) {
      // Exactly two non-empty bounds. Rejects "-1" (empty lo → Number("")=0),
      // "1-" (empty hi), "-" and "1-3-5" — all fail-closed.
      const segParts = seg.split("-");
      if (segParts.length !== 2 || segParts[0] === "" || segParts[1] === "") {
        throw new Error(`config: WINDOW_DAYS has invalid range "${seg}"`);
      }
      const lo = Number(segParts[0]);
      const hi = Number(segParts[1]);
      if (
        !Number.isInteger(lo) ||
        !Number.isInteger(hi) ||
        lo < 0 ||
        hi > 6 ||
        lo > hi
      ) {
        throw new Error(`config: WINDOW_DAYS has invalid range "${seg}"`);
      }
      for (let d = lo; d <= hi; d++) out.add(d);
    } else {
      const d = Number(seg);
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        throw new Error(`config: WINDOW_DAYS has invalid day "${seg}"`);
      }
      out.add(d);
    }
  }
  if (out.size === 0)
    throw new Error(`config: WINDOW_DAYS="${raw}" yielded no days`);
  return [...out].sort((a, b) => a - b);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const startHour = numEnv(env, "WINDOW_START_HOUR", 10, { min: 0, max: 23 });
  const endHour = numEnv(env, "WINDOW_END_HOUR", 19, { min: 1, max: 24 });
  // Assert the post-coercion invariant (M1: a partial reset left it inverted).
  if (endHour <= startHour) {
    throw new Error(
      `config: WINDOW_END_HOUR (${endHour}) must be greater than WINDOW_START_HOUR (${startHour})`,
    );
  }

  const answerRateFloor = (() => {
    const raw = env["ANSWER_RATE_FLOOR"];
    if (raw === undefined || raw.trim() === "") return 0.1;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1)
      throw new Error(`config: ANSWER_RATE_FLOOR="${raw}" must be in [0, 1]`);
    return n;
  })();

  return {
    campaignEnabled: env["CAMPAIGN_ENABLED"] === "true",
    timezone: env["TZ_OUTREACH"] ?? "America/Mexico_City",
    window: {
      days: parseDays(env["WINDOW_DAYS"], [1, 2, 3, 4, 5, 6]), // Mon–Sat
      startHour,
      endHour,
    },
    maxConcurrentCalls: numEnv(env, "MAX_CONCURRENT_CALLS", 3, {
      min: 1,
      max: 1000,
    }),
    maxAttempts: numEnv(env, "MAX_ATTEMPTS", 2, { min: 1, max: 10 }),
    retryBackoffHours: numEnv(env, "RETRY_BACKOFF_HOURS", 24, {
      min: 1, // ≥1h: never an unpaced retry against the same number (QA W2)
      max: 720,
    }),
    stuckDialingMinutes: numEnv(env, "STUCK_DIALING_MINUTES", 15, {
      min: 1,
      max: 240,
    }),
    answerRateFloor,
    dbPath: env["ORCHESTRATOR_DB"] ?? "./data/orchestrator.db",
  };
}
