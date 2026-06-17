import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb, type DB } from "../src/db.js";
import type { Config } from "../src/config.js";
import { FakePipesongClient } from "../src/pipesong-client.js";
import {
  tick,
  recordDisposition,
  sweepStuckDialing,
  type Campaign,
} from "../src/dialer.js";

const WED_NOON_MX = new Date("2026-06-17T18:00:00Z"); // in window
const SUN_NOON_MX = new Date("2026-06-14T18:00:00Z"); // out of window (Sun)
const CAMPAIGN: Campaign = { id: "camp-1", agentId: "agent-1" };

function cfg(o: Partial<Config> = {}): Config {
  return {
    campaignEnabled: true,
    timezone: "America/Mexico_City",
    window: { days: [1, 2, 3, 4, 5, 6], startHour: 10, endHour: 19 },
    maxConcurrentCalls: 3,
    maxAttempts: 2,
    retryBackoffHours: 24,
    stuckDialingMinutes: 15,
    answerRateFloor: 0.1,
    dbPath: ":memory:",
    voiceCostPerMinuteCents: 3,
    crmSyncBatch: 100,
    crmBaseUrl: null,
    crmApiKey: null,
    ...o,
  };
}

/** Insert a queued prospect. `eligible` is a SQLite datetime modifier ('+0 hours' = now). */
function insertQueued(
  db: DB,
  phone: string,
  opts: { eligible?: string; attempts?: number } = {},
): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO prospect(id, name, colonia, phone_e164, attempts, next_eligible_at) VALUES (?,?,?,?,?, datetime('now', ?))",
  ).run(
    id,
    "Salón",
    "Centro",
    phone,
    opts.attempts ?? 0,
    opts.eligible ?? "+0 hours",
  );
  return id;
}

const stateOf = (db: DB, id: string) =>
  (
    db.prepare("SELECT state FROM prospect WHERE id = ?").get(id) as {
      state: string;
    }
  ).state;

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => db.close());

describe("tick — global gates", () => {
  it("kill-switch off → no dials", async () => {
    insertQueued(db, "+521111");
    const fake = new FakePipesongClient();
    const r = await tick(
      db,
      cfg({ campaignEnabled: false }),
      fake,
      CAMPAIGN,
      WED_NOON_MX,
    );
    expect(r).toEqual({ dialed: 0, reason: "campaign_disabled" });
    expect(fake.calls).toHaveLength(0);
  });
  it("outside the window → no dials", async () => {
    insertQueued(db, "+521111");
    const fake = new FakePipesongClient();
    const r = await tick(db, cfg(), fake, CAMPAIGN, SUN_NOON_MX);
    expect(r).toEqual({ dialed: 0, reason: "outside_window" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("tick — dialing", () => {
  it("dials eligible prospects and records each attempt", async () => {
    const a = insertQueued(db, "+521111");
    const b = insertQueued(db, "+522222");
    const fake = new FakePipesongClient();
    const r = await tick(db, cfg(), fake, CAMPAIGN, WED_NOON_MX);
    expect(r.dialed).toBe(2);
    expect(fake.calls).toHaveLength(2);
    expect(stateOf(db, a)).toBe("dialing");
    expect(stateOf(db, b)).toBe("dialing");
    // per-call vars injected from the prospect row
    expect(fake.calls[0]).toMatchObject({
      agentId: "agent-1",
      variables: { nombre: "Salón", colonia: "Centro" },
    });
    const attempts = db
      .prepare("SELECT attempts FROM prospect WHERE id = ?")
      .get(a) as { attempts: number };
    expect(attempts.attempts).toBe(1);
    const ca = db
      .prepare(
        "SELECT COUNT(*) AS n FROM call_attempt WHERE pipesong_call_id IS NOT NULL",
      )
      .get() as { n: number };
    expect(ca.n).toBe(2);
  });

  it("honors the concurrency cap", async () => {
    insertQueued(db, "+521111");
    insertQueued(db, "+522222");
    insertQueued(db, "+523333");
    const fake = new FakePipesongClient();
    const r = await tick(
      db,
      cfg({ maxConcurrentCalls: 1 }),
      fake,
      CAMPAIGN,
      WED_NOON_MX,
    );
    expect(r.dialed).toBe(1);
    expect(fake.calls).toHaveLength(1);
    const dialing = db
      .prepare("SELECT COUNT(*) AS n FROM prospect WHERE state = 'dialing'")
      .get() as { n: number };
    expect(dialing.n).toBe(1);
  });

  it("excludes DNC numbers", async () => {
    insertQueued(db, "+521111");
    db.prepare("INSERT INTO dnc(phone_e164) VALUES (?)").run("+521111");
    const fake = new FakePipesongClient();
    const r = await tick(db, cfg(), fake, CAMPAIGN, WED_NOON_MX);
    expect(r.dialed).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("skips prospects at the attempt cap", async () => {
    insertQueued(db, "+521111", { attempts: 2 }); // == maxAttempts
    const fake = new FakePipesongClient();
    const r = await tick(db, cfg(), fake, CAMPAIGN, WED_NOON_MX);
    expect(r.dialed).toBe(0);
  });

  it("skips prospects whose backoff hasn't elapsed (next_eligible_at future)", async () => {
    insertQueued(db, "+521111", { eligible: "+1 hour" });
    const fake = new FakePipesongClient();
    const r = await tick(db, cfg(), fake, CAMPAIGN, WED_NOON_MX);
    expect(r.dialed).toBe(0);
  });

  it("does not re-dial a prospect already dialing", async () => {
    insertQueued(db, "+521111");
    const fake = new FakePipesongClient();
    await tick(db, cfg(), fake, CAMPAIGN, WED_NOON_MX); // now dialing
    const r2 = await tick(db, cfg(), fake, CAMPAIGN, WED_NOON_MX);
    expect(r2.dialed).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("tick — origination failure", () => {
  it("a failed origination re-queues under the cap, with a future backoff", async () => {
    const id = insertQueued(db, "+521111");
    const fake = new FakePipesongClient({ fail: true });
    const r = await tick(db, cfg(), fake, CAMPAIGN, WED_NOON_MX);
    expect(r.dialed).toBe(1);
    expect(stateOf(db, id)).toBe("queued"); // requeued (attempts 1 < 2)
    const row = db
      .prepare(
        "SELECT (next_eligible_at > datetime('now')) AS future, disposition FROM prospect p JOIN call_attempt c ON c.prospect_id = p.id WHERE p.id = ?",
      )
      .get(id) as { future: number; disposition: string };
    expect(row.future).toBe(1); // backed off into the future
    expect(row.disposition).toBe("failed");
  });

  it("a failed origination at the cap exhausts the prospect", async () => {
    const id = insertQueued(db, "+521111", { attempts: 1 }); // claim → 2 = cap
    const fake = new FakePipesongClient({ fail: true });
    await tick(db, cfg(), fake, CAMPAIGN, WED_NOON_MX);
    expect(stateOf(db, id)).toBe("exhausted");
  });
});

describe("recordDisposition — canonical timestamp + transitions", () => {
  it("qualified → qualified", () => {
    const id = insertQueued(db, "+521111");
    recordDisposition(db, cfg(), id, "qualified");
    expect(stateOf(db, id)).toBe("qualified");
  });

  it("no_answer under cap → queued, next_eligible_at advanced ~retryBackoffHours via SQL datetime()", () => {
    const id = insertQueued(db, "+521111", { attempts: 1 });
    recordDisposition(db, cfg({ retryBackoffHours: 24 }), id, "no_answer");
    const row = db
      .prepare(
        "SELECT state, next_eligible_at, (next_eligible_at > datetime('now','+23 hours')) AS gt23, (next_eligible_at <= datetime('now','+25 hours')) AS le25 FROM prospect WHERE id = ?",
      )
      .get(id) as {
      state: string;
      next_eligible_at: string;
      gt23: number;
      le25: number;
    };
    expect(row.state).toBe("queued");
    expect(row.gt23).toBe(1);
    expect(row.le25).toBe(1);
    // canonical SQLite datetime format: space-separated, no 'T'/'Z'
    expect(row.next_eligible_at).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
  });

  it("no_answer at cap → exhausted (no requeue)", () => {
    const id = insertQueued(db, "+521111", { attempts: 2 });
    recordDisposition(db, cfg(), id, "no_answer");
    expect(stateOf(db, id)).toBe("exhausted");
  });

  it("is a no-op for an unknown prospect id", () => {
    expect(() =>
      recordDisposition(db, cfg(), "nope", "qualified"),
    ).not.toThrow();
  });
});

/** Force a prospect into `dialing` with an aged last_attempt_at (simulates a
 *  call that started but whose webhook never arrived). */
function forceDialing(
  db: DB,
  id: string,
  ageModifier: string,
  attempts = 1,
): void {
  db.prepare(
    "UPDATE prospect SET state = 'dialing', attempts = ?, last_attempt_at = datetime('now', ?) WHERE id = ?",
  ).run(attempts, ageModifier, id);
}

describe("sweepStuckDialing — slot-leak reaper (QA W1)", () => {
  it("reaps a prospect stuck dialing past the threshold (frees the slot)", () => {
    const id = insertQueued(db, "+521111");
    forceDialing(db, id, "-20 minutes", 1); // older than stuckDialingMinutes=15
    const reaped = sweepStuckDialing(db, cfg());
    expect(reaped).toBe(1);
    expect(stateOf(db, id)).toBe("queued"); // failed → requeued (attempts 1 < 2)
  });

  it("does NOT reap a call still within the threshold", () => {
    const id = insertQueued(db, "+521111");
    forceDialing(db, id, "-5 minutes", 1); // younger than 15
    expect(sweepStuckDialing(db, cfg())).toBe(0);
    expect(stateOf(db, id)).toBe("dialing");
  });

  it("a stuck dial at the cap is exhausted, not requeued", () => {
    const id = insertQueued(db, "+521111");
    forceDialing(db, id, "-20 minutes", 2); // attempts at cap
    sweepStuckDialing(db, cfg());
    expect(stateOf(db, id)).toBe("exhausted");
  });

  it("tick() reaps a leaked slot so dialing can resume", async () => {
    const stuck = insertQueued(db, "+521111");
    forceDialing(db, stuck, "-20 minutes", 1); // leaked slot
    const fresh = insertQueued(db, "+522222");
    const fake = new FakePipesongClient();
    const r = await tick(
      db,
      cfg({ maxConcurrentCalls: 1 }),
      fake,
      CAMPAIGN,
      WED_NOON_MX,
    );
    // reaper freed the stuck slot (→ queued+backoff), so the fresh prospect dials
    expect(stateOf(db, stuck)).toBe("queued");
    expect(stateOf(db, fresh)).toBe("dialing");
    expect(r.dialed).toBe(1);
  });
});

describe("tick — concurrency cap holds under interleaved runs (QA R1)", () => {
  it("never exceeds maxConcurrentCalls with 3 concurrent ticks", async () => {
    for (let i = 0; i < 10; i++) insertQueued(db, `+5219${i}`);
    const fake = new FakePipesongClient();
    const c = cfg({ maxConcurrentCalls: 3 });
    const results = await Promise.all([
      tick(db, c, fake, CAMPAIGN, WED_NOON_MX),
      tick(db, c, fake, CAMPAIGN, WED_NOON_MX),
      tick(db, c, fake, CAMPAIGN, WED_NOON_MX),
    ]);
    const dialing = (
      db
        .prepare("SELECT COUNT(*) AS n FROM prospect WHERE state = 'dialing'")
        .get() as {
        n: number;
      }
    ).n;
    expect(dialing).toBeLessThanOrEqual(3); // cap never exceeded — the invariant
    const totalDialed = results.reduce((s, r) => s + r.dialed, 0);
    expect(totalDialed).toBeLessThanOrEqual(3);
    expect(dialing).toBeGreaterThan(0); // progress was made
  });
});
