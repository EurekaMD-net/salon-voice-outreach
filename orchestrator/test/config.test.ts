import { describe, it, expect } from "vitest";
import { loadConfig, parseDays } from "../src/config.js";

const MON_SAT = [1, 2, 3, 4, 5, 6];

describe("parseDays — fail-closed", () => {
  it("absent → default (safe)", () => {
    expect(parseDays(undefined, MON_SAT)).toEqual(MON_SAT);
    expect(parseDays("", MON_SAT)).toEqual(MON_SAT);
  });
  it("parses valid ranges and lists", () => {
    expect(parseDays("1-5", MON_SAT)).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays("0,6", MON_SAT)).toEqual([0, 6]);
    expect(parseDays("1-3,5", MON_SAT)).toEqual([1, 2, 3, 5]);
  });
  it("THROWS on present-but-invalid (never silently widens the window)", () => {
    expect(() => parseDays("8", MON_SAT)).toThrow(/WINDOW_DAYS/); // out of range
    expect(() => parseDays("6-1", MON_SAT)).toThrow(/WINDOW_DAYS/); // reversed
    expect(() => parseDays("abc", MON_SAT)).toThrow(/WINDOW_DAYS/);
    expect(() => parseDays("-1", MON_SAT)).toThrow(/WINDOW_DAYS/);
    expect(() => parseDays("1-", MON_SAT)).toThrow(/WINDOW_DAYS/);
  });
});

describe("loadConfig — defaults + kill-switch", () => {
  it("safe defaults with empty env; kill-switch OFF", () => {
    const c = loadConfig({});
    expect(c.campaignEnabled).toBe(false);
    expect(c.timezone).toBe("America/Mexico_City");
    expect(c.window).toEqual({ days: MON_SAT, startHour: 10, endHour: 19 });
    expect(c.maxConcurrentCalls).toBe(3);
    expect(c.maxAttempts).toBe(2);
  });
  it("kill-switch only true for the exact string 'true'", () => {
    expect(loadConfig({ CAMPAIGN_ENABLED: "true" }).campaignEnabled).toBe(true);
    for (const v of ["1", "yes", "TRUE", "on", ""]) {
      expect(loadConfig({ CAMPAIGN_ENABLED: v }).campaignEnabled).toBe(false);
    }
  });
});

describe("loadConfig — fail-closed numeric caps (QA H2)", () => {
  it("rejects a non-integer MAX_ATTEMPTS (would permit a 3rd attempt)", () => {
    expect(() => loadConfig({ MAX_ATTEMPTS: "2.9" })).toThrow(/MAX_ATTEMPTS/);
  });
  it("rejects MAX_ATTEMPTS below 1", () => {
    expect(() => loadConfig({ MAX_ATTEMPTS: "0" })).toThrow(/MAX_ATTEMPTS/);
  });
  it("rejects a negative MAX_CONCURRENT_CALLS", () => {
    expect(() => loadConfig({ MAX_CONCURRENT_CALLS: "-5" })).toThrow(
      /MAX_CONCURRENT_CALLS/,
    );
  });
  it("rejects a non-numeric cap", () => {
    expect(() => loadConfig({ MAX_CONCURRENT_CALLS: "lots" })).toThrow(
      /MAX_CONCURRENT_CALLS/,
    );
  });
  it("rejects ANSWER_RATE_FLOOR outside [0,1]", () => {
    expect(() => loadConfig({ ANSWER_RATE_FLOOR: "1.5" })).toThrow(
      /ANSWER_RATE_FLOOR/,
    );
  });
  it("accepts valid overrides", () => {
    const c = loadConfig({ MAX_ATTEMPTS: "3", MAX_CONCURRENT_CALLS: "8" });
    expect(c.maxAttempts).toBe(3);
    expect(c.maxConcurrentCalls).toBe(8);
  });
});

describe("loadConfig — CRM sync config (fail-closed)", () => {
  it("defaults: cost 3¢/min, batch 100, no CRM URL/key", () => {
    const c = loadConfig({});
    expect(c.voiceCostPerMinuteCents).toBe(3);
    expect(c.crmSyncBatch).toBe(100);
    expect(c.crmBaseUrl).toBeNull();
    expect(c.crmApiKey).toBeNull();
  });
  it("rejects a present-but-short CRM_API_KEY (would only 401 at runtime)", () => {
    expect(() => loadConfig({ CRM_API_KEY: "short" })).toThrow(/CRM_API_KEY/);
  });
  it("accepts a ≥16-char CRM_API_KEY and trims a blank to null", () => {
    expect(loadConfig({ CRM_API_KEY: "this-is-16-chars!" }).crmApiKey).toBe(
      "this-is-16-chars!",
    );
    expect(loadConfig({ CRM_API_KEY: "   " }).crmApiKey).toBeNull();
  });
  it("rejects a non-integer / negative voice cost", () => {
    expect(() => loadConfig({ VOICE_COST_PER_MINUTE_CENTS: "-1" })).toThrow(
      /VOICE_COST_PER_MINUTE_CENTS/,
    );
    expect(() => loadConfig({ CRM_SYNC_BATCH: "0" })).toThrow(/CRM_SYNC_BATCH/);
  });
});

describe("loadConfig — window guard (QA M1)", () => {
  it("rejects an inverted window instead of silently never-dialing", () => {
    expect(() =>
      loadConfig({ WINDOW_START_HOUR: "20", WINDOW_END_HOUR: "19" }),
    ).toThrow(/WINDOW_END_HOUR/);
  });
  it("rejects equal start/end (zero-width window)", () => {
    expect(() =>
      loadConfig({ WINDOW_START_HOUR: "10", WINDOW_END_HOUR: "10" }),
    ).toThrow(/WINDOW_END_HOUR/);
  });
  it("rejects an out-of-range hour", () => {
    expect(() => loadConfig({ WINDOW_START_HOUR: "25" })).toThrow(
      /WINDOW_START_HOUR/,
    );
  });
  it("accepts a valid custom window", () => {
    const c = loadConfig({ WINDOW_START_HOUR: "9", WINDOW_END_HOUR: "20" });
    expect(c.window.startHour).toBe(9);
    expect(c.window.endHour).toBe(20);
  });
});
