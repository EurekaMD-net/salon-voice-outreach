import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb, type DB } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { FakeCrmClient } from "../src/crm-client.js";
import { syncPendingLeads } from "../src/crm-sync.js";

const cfg = loadConfig({});

let seq = 0;
/** Seed one prospect + call_attempt. Returns the call_attempt id. */
function seedAttempt(
  db: DB,
  opts: {
    disposition?: string | null;
    duration_s?: number | null;
    synced?: boolean;
  } = {},
): string {
  const { disposition = "connected", duration_s = null, synced = false } = opts;
  seq += 1;
  const pid = randomUUID();
  db.prepare(
    "INSERT INTO prospect (id, name, colonia, phone_e164, ig_handle, source) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    pid,
    `Salón ${seq}`,
    "Centro",
    `+521550000${seq}`,
    "@ig",
    "denue-pilot",
  );
  const caid = randomUUID();
  db.prepare(
    `INSERT INTO call_attempt
       (id, prospect_id, campaign_id, pipesong_call_id, duration_s, disposition, crm_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    caid,
    pid,
    "camp-1",
    "ps",
    duration_s,
    disposition,
    synced ? "2025-01-01 00:00:00" : null,
  );
  return caid;
}

const unsyncedCount = (db: DB) =>
  (
    db
      .prepare(
        "SELECT COUNT(*) n FROM call_attempt WHERE disposition IS NOT NULL AND crm_synced_at IS NULL",
      )
      .get() as { n: number }
  ).n;

describe("syncPendingLeads (outbox pump)", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("drains finalized, unsynced attempts and marks them synced", async () => {
    seedAttempt(db, { disposition: "qualified", duration_s: 120 });
    seedAttempt(db, { disposition: "no_answer" });
    const crm = new FakeCrmClient();
    const r = await syncPendingLeads(db, cfg, crm);
    expect(r).toEqual({ synced: 2, failed: 0 });
    expect(crm.events).toHaveLength(2);
    expect(unsyncedCount(db)).toBe(0);
  });

  it("skips attempts that aren't finalized (disposition IS NULL)", async () => {
    seedAttempt(db, { disposition: null });
    const crm = new FakeCrmClient();
    const r = await syncPendingLeads(db, cfg, crm);
    expect(r.synced).toBe(0);
    expect(crm.events).toHaveLength(0);
  });

  it("is idempotent — a second run emits nothing", async () => {
    seedAttempt(db, { disposition: "connected" });
    const crm = new FakeCrmClient();
    await syncPendingLeads(db, cfg, crm);
    const r2 = await syncPendingLeads(db, cfg, crm);
    expect(r2.synced).toBe(0);
    expect(crm.events).toHaveLength(1);
  });

  it("leaves rows unsynced when the CRM fails, and recovers on retry", async () => {
    seedAttempt(db, { disposition: "connected" });
    const r = await syncPendingLeads(
      db,
      cfg,
      new FakeCrmClient({ fail: true }),
    );
    expect(r).toEqual({ synced: 0, failed: 1 });
    expect(unsyncedCount(db)).toBe(1);

    const r2 = await syncPendingLeads(db, cfg, new FakeCrmClient());
    expect(r2.synced).toBe(1);
    expect(unsyncedCount(db)).toBe(0);
  });

  it("respects the batch limit across runs", async () => {
    seedAttempt(db, { disposition: "connected" });
    seedAttempt(db, { disposition: "connected" });
    seedAttempt(db, { disposition: "connected" });
    const crm = new FakeCrmClient();
    const batched = { ...cfg, crmSyncBatch: 2 };
    expect((await syncPendingLeads(db, batched, crm)).synced).toBe(2);
    expect((await syncPendingLeads(db, batched, crm)).synced).toBe(1);
  });

  it("excludes un-emittable empty-phone rows (no poison-pill / head-of-line block)", async () => {
    // a prospect with phone_e164 = '' (NOT NULL still permits it) → vlcrm would
    // 400 on accountKey='' and the row would retry forever. It must be skipped,
    // and must NOT block a healthy row sharing the batch.
    const badPid = randomUUID();
    db.prepare(
      "INSERT INTO prospect (id, name, phone_e164, source) VALUES (?, ?, '', ?)",
    ).run(badPid, "No Phone", "denue-pilot");
    db.prepare(
      "INSERT INTO call_attempt (id, prospect_id, campaign_id, disposition) VALUES (?, ?, ?, ?)",
    ).run(randomUUID(), badPid, "camp-1", "connected");
    seedAttempt(db, { disposition: "connected" }); // healthy

    const crm = new FakeCrmClient();
    const r = await syncPendingLeads(db, cfg, crm);
    expect(r.synced).toBe(1); // only the healthy row
    expect(crm.events).toHaveLength(1);
    expect(crm.events[0]!.accountKey).not.toBe("");
    // the bad row is simply never selected — it stays unsynced but doesn't block
    const badUnsynced = db
      .prepare("SELECT crm_synced_at FROM call_attempt WHERE prospect_id = ?")
      .get(badPid) as { crm_synced_at: string | null };
    expect(badUnsynced.crm_synced_at).toBeNull();
  });

  it("maps the joined prospect into the event (cost from duration)", async () => {
    seedAttempt(db, { disposition: "qualified", duration_s: 90 });
    const crm = new FakeCrmClient();
    await syncPendingLeads(db, cfg, crm);
    const e = crm.events[0]!;
    expect(e.type).toBe("qualified");
    expect(e.costCents).toBe(6); // ceil(90/60)=2 × 3¢
    expect(e.accountKey).toMatch(/^\+52/);
    expect(e.source).toBe("denue");
  });
});
