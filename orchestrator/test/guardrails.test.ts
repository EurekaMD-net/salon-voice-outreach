import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb, type DB } from "../src/db.js";
import type { Config } from "../src/config.js";
import {
  localParts,
  isCampaignEnabled,
  isWithinWindow,
  isDncBlocked,
  underFrequencyCap,
  freeConcurrencySlots,
  canDial,
} from "../src/guardrails.js";

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    campaignEnabled: true,
    timezone: "America/Mexico_City",
    window: { days: [1, 2, 3, 4, 5, 6], startHour: 10, endHour: 19 }, // Mon–Sat 10–19
    maxConcurrentCalls: 3,
    maxAttempts: 2,
    retryBackoffHours: 24,
    stuckDialingMinutes: 15,
    answerRateFloor: 0.1,
    dbPath: ":memory:",
    ...overrides,
  };
}

// 2026-06-17 is a Wednesday; 2026-06-14 is a Sunday. MX = UTC-6 (no DST).
const WED_NOON_MX = new Date("2026-06-17T18:00:00Z"); // 12:00 MX Wed
const SUN_NOON_MX = new Date("2026-06-14T18:00:00Z"); // 12:00 MX Sun

describe("localParts", () => {
  it("maps a UTC instant to MX-local weekday + hour", () => {
    const { hour, weekday } = localParts(WED_NOON_MX, "America/Mexico_City");
    expect(weekday).toBe(3); // Wed
    expect(hour).toBe(12);
  });
  it("is timezone-aware, not VPS-local", () => {
    // Same instant, evaluated in UTC, is 18:00.
    expect(localParts(WED_NOON_MX, "UTC").hour).toBe(18);
  });
});

describe("isWithinWindow", () => {
  it("accepts a weekday inside hours", () => {
    expect(isWithinWindow(WED_NOON_MX, cfg())).toBe(true);
  });
  it("rejects Sunday (not in Mon–Sat)", () => {
    expect(isWithinWindow(SUN_NOON_MX, cfg())).toBe(false);
  });
  it("rejects too-early (08:00 MX = 14:00 UTC; margin keeps it DST-robust)", () => {
    expect(isWithinWindow(new Date("2026-06-17T14:00:00Z"), cfg())).toBe(false);
  });
  it("rejects too-late (21:00 MX = 03:00 UTC next day)", () => {
    expect(isWithinWindow(new Date("2026-06-18T03:00:00Z"), cfg())).toBe(false);
  });
  it("uses pure comparison logic correctly under fixed UTC", () => {
    const c = cfg({
      timezone: "UTC",
      window: { days: [3], startHour: 10, endHour: 19 },
    });
    expect(isWithinWindow(new Date("2026-06-17T09:59:00Z"), c)).toBe(false); // 09:59
    expect(isWithinWindow(new Date("2026-06-17T10:00:00Z"), c)).toBe(true); // 10:00 inclusive
    expect(isWithinWindow(new Date("2026-06-17T18:59:00Z"), c)).toBe(true); // 18:59
    expect(isWithinWindow(new Date("2026-06-17T19:00:00Z"), c)).toBe(false); // 19:00 exclusive
  });
});

describe("kill-switch", () => {
  it("defaults gate to disabled", () => {
    expect(isCampaignEnabled(cfg({ campaignEnabled: false }))).toBe(false);
  });
});

describe("frequency cap", () => {
  it("allows under cap, blocks at cap", () => {
    const c = cfg({ maxAttempts: 2 });
    expect(underFrequencyCap(0, c)).toBe(true);
    expect(underFrequencyCap(1, c)).toBe(true);
    expect(underFrequencyCap(2, c)).toBe(false);
  });
});

describe("db-backed gates", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("isDncBlocked reflects the dnc table", () => {
    expect(isDncBlocked(db, "+5215555555555")).toBe(false);
    db.prepare("INSERT INTO dnc(phone_e164, reason) VALUES (?, ?)").run(
      "+5215555555555",
      "no me llames",
    );
    expect(isDncBlocked(db, "+5215555555555")).toBe(true);
  });

  it("freeConcurrencySlots = cap minus live dials", () => {
    const c = cfg({ maxConcurrentCalls: 3 });
    expect(freeConcurrencySlots(db, c)).toBe(3);
    const ins = db.prepare(
      "INSERT INTO prospect(id, phone_e164, state) VALUES (?, ?, 'dialing')",
    );
    ins.run(randomUUID(), "+521111");
    ins.run(randomUUID(), "+522222");
    expect(freeConcurrencySlots(db, c)).toBe(1);
  });
});

describe("canDial (the chokepoint)", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  const prospect = { phone_e164: "+5215555555555", attempts: 0 };

  it("blocks when campaign disabled", () => {
    expect(
      canDial(db, cfg({ campaignEnabled: false }), prospect, WED_NOON_MX),
    ).toEqual({
      ok: false,
      reason: "campaign_disabled",
    });
  });
  it("blocks outside the window", () => {
    expect(canDial(db, cfg(), prospect, SUN_NOON_MX)).toEqual({
      ok: false,
      reason: "outside_window",
    });
  });
  it("blocks a DNC number", () => {
    db.prepare("INSERT INTO dnc(phone_e164) VALUES (?)").run(
      prospect.phone_e164,
    );
    expect(canDial(db, cfg(), prospect, WED_NOON_MX)).toEqual({
      ok: false,
      reason: "dnc",
    });
  });
  it("blocks at the attempt cap", () => {
    expect(
      canDial(db, cfg(), { ...prospect, attempts: 2 }, WED_NOON_MX),
    ).toEqual({ ok: false, reason: "frequency_cap" });
  });
  it("allows when every gate passes", () => {
    expect(canDial(db, cfg(), prospect, WED_NOON_MX)).toEqual({ ok: true });
  });
});
