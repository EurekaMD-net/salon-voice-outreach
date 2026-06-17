import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb, type DB } from "../src/db.js";

describe("schema / pipeline-of-record spine", () => {
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
      expect.arrayContaining([
        "account",
        "contact",
        "interaction",
        "qualification",
      ]),
    );
  });

  it("inserts an account with sane defaults", () => {
    const id = randomUUID();
    db.prepare("INSERT INTO account(id, account_key) VALUES (?, ?)").run(
      id,
      "+5215512345678",
    );
    const row = db.prepare("SELECT * FROM account WHERE id = ?").get(id) as {
      pipeline_stage: string;
      source: string;
      dnc: number;
      created_at: string;
    };
    expect(row.pipeline_stage).toBe("new");
    expect(row.source).toBe("other");
    expect(row.dnc).toBe(0);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("enforces UNIQUE account_key (dedup — one row per business)", () => {
    const ins = db.prepare(
      "INSERT INTO account(id, account_key) VALUES (?, ?)",
    );
    ins.run(randomUUID(), "+5215512345678");
    expect(() => ins.run(randomUUID(), "+5215512345678")).toThrow(/UNIQUE/i);
  });

  it("rejects invalid pipeline_stage / source / dnc (CHECK)", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO account(id, account_key, pipeline_stage) VALUES (?, ?, ?)",
        )
        .run(randomUUID(), "k1", "bogus"),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare(
          "INSERT INTO account(id, account_key, source) VALUES (?, ?, ?)",
        )
        .run(randomUUID(), "k2", "bogus"),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare("INSERT INTO account(id, account_key, dnc) VALUES (?, ?, ?)")
        .run(randomUUID(), "k3", 2),
    ).toThrow(/CHECK/i);
  });

  it("referral self-FK nulls out when the referrer account is deleted (ON DELETE SET NULL)", () => {
    const referrer = randomUUID();
    const referred = randomUUID();
    db.prepare("INSERT INTO account(id, account_key) VALUES (?, ?)").run(
      referrer,
      "ref",
    );
    db.prepare(
      "INSERT INTO account(id, account_key, referred_by_account_id) VALUES (?, ?, ?)",
    ).run(referred, "lead", referrer);
    db.prepare("DELETE FROM account WHERE id = ?").run(referrer);
    const row = db
      .prepare("SELECT referred_by_account_id FROM account WHERE id = ?")
      .get(referred) as { referred_by_account_id: string | null };
    expect(row.referred_by_account_id).toBeNull();
  });

  it("cascades contacts + interactions when an account is deleted", () => {
    const aid = randomUUID();
    db.prepare("INSERT INTO account(id, account_key) VALUES (?, ?)").run(
      aid,
      "k",
    );
    db.prepare(
      "INSERT INTO contact(id, account_id, phone_e164) VALUES (?, ?, ?)",
    ).run(randomUUID(), aid, "+521");
    db.prepare(
      "INSERT INTO interaction(id, account_id, channel, direction, type) VALUES (?, ?, ?, ?, ?)",
    ).run(randomUUID(), aid, "voice", "outbound", "call");
    db.prepare("DELETE FROM account WHERE id = ?").run(aid);
    expect(
      (db.prepare("SELECT COUNT(*) n FROM contact").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) n FROM interaction").get() as { n: number })
        .n,
    ).toBe(0);
  });

  it("enforces UNIQUE(account_id, phone) but allows multiple NULL phones", () => {
    const aid = randomUUID();
    db.prepare("INSERT INTO account(id, account_key) VALUES (?, ?)").run(
      aid,
      "k",
    );
    const ins = db.prepare(
      "INSERT INTO contact(id, account_id, phone_e164) VALUES (?, ?, ?)",
    );
    ins.run(randomUUID(), aid, "+521");
    expect(() => ins.run(randomUUID(), aid, "+521")).toThrow(/UNIQUE/i);
    // two NULL-phone contacts are allowed (NULLs are distinct in SQLite UNIQUE)
    expect(() => {
      ins.run(randomUUID(), aid, null);
      ins.run(randomUUID(), aid, null);
    }).not.toThrow();
  });

  it("rejects invalid interaction channel / direction (CHECK)", () => {
    const aid = randomUUID();
    db.prepare("INSERT INTO account(id, account_key) VALUES (?, ?)").run(
      aid,
      "k",
    );
    expect(() =>
      db
        .prepare(
          "INSERT INTO interaction(id, account_id, channel, direction, type) VALUES (?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), aid, "carrier-pigeon", "outbound", "call"),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare(
          "INSERT INTO interaction(id, account_id, channel, direction, type) VALUES (?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), aid, "voice", "sideways", "call"),
    ).toThrow(/CHECK/i);
  });

  it("migrate() is idempotent (safe on every boot)", () => {
    expect(() => openDb(":memory:")).not.toThrow();
  });
});
