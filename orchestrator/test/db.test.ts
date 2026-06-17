import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb, type DB } from "../src/db.js";

describe("schema / capture spine", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("creates the four tables", () => {
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["call_attempt", "campaign", "dnc", "prospect"]),
    );
  });

  it("inserts a prospect with sane defaults", () => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO prospect(id, name, phone_e164) VALUES (?, ?, ?)",
    ).run(id, "Salón Demo", "+5215616233586");
    const row = db.prepare("SELECT * FROM prospect WHERE id = ?").get(id) as {
      state: string;
      attempts: number;
      source: string;
      created_at: string;
    };
    expect(row.state).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(row.source).toContain("denue");
    expect(row.created_at).toBeTruthy();
  });

  it("enforces UNIQUE phone (dedupe — never two rows per number)", () => {
    const ins = db.prepare(
      "INSERT INTO prospect(id, phone_e164) VALUES (?, ?)",
    );
    ins.run(randomUUID(), "+5215616233586");
    expect(() => ins.run(randomUUID(), "+5215616233586")).toThrow(/UNIQUE/i);
  });

  it("rejects an invalid prospect state (CHECK constraint)", () => {
    expect(() =>
      db
        .prepare("INSERT INTO prospect(id, phone_e164, state) VALUES (?, ?, ?)")
        .run(randomUUID(), "+521999", "bogus"),
    ).toThrow(/CHECK/i);
  });

  it("captures a call_attempt with raw payload + optin flag", () => {
    const pid = randomUUID();
    db.prepare("INSERT INTO prospect(id, phone_e164) VALUES (?, ?)").run(
      pid,
      "+521888",
    );
    const cid = randomUUID();
    db.prepare(
      "INSERT INTO call_attempt(id, prospect_id, campaign_id, disposition, optin_sent, raw) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      cid,
      pid,
      "camp-1",
      "qualified",
      1,
      JSON.stringify({ event: "call_ended" }),
    );
    const row = db
      .prepare("SELECT * FROM call_attempt WHERE id = ?")
      .get(cid) as {
      disposition: string;
      optin_sent: number;
      raw: string;
    };
    expect(row.disposition).toBe("qualified");
    expect(row.optin_sent).toBe(1);
    expect(JSON.parse(row.raw).event).toBe("call_ended");
  });

  it("migrate() is idempotent (safe on every boot)", () => {
    expect(() => openDb(":memory:")).not.toThrow();
  });
});
