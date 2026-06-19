import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { ingestLeadEvent } from "../src/ingest.js";
import type { LeadEvent } from "../src/lead-event.js";
import type { Account } from "../src/types.js";

const salesPhoneLead = (over: Partial<LeadEvent> = {}): LeadEvent => ({
  accountKey: "+5215512345678",
  channel: "sales_phone",
  direction: "inbound",
  type: "manual_intake",
  source: "sales_phone",
  name: "Salón Demo",
  ...over,
});

function acct(db: DB, key: string): Account {
  return db
    .prepare("SELECT * FROM account WHERE account_key = ?")
    .get(key) as Account;
}

describe("ingestLeadEvent", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("creates a new account from a sales-phone manual intake", () => {
    const r = ingestLeadEvent(db, salesPhoneLead());
    expect(r.created).toBe(true);
    expect(r.stage).toBe("contacted");
    const a = acct(db, "+5215512345678");
    expect(a.source).toBe("sales_phone");
    expect(a.name).toBe("Salón Demo");
    const inter = db
      .prepare("SELECT * FROM interaction WHERE account_id = ?")
      .get(a.id) as { channel: string; direction: string; type: string };
    expect(inter.channel).toBe("sales_phone");
    expect(inter.direction).toBe("inbound");
    expect(inter.type).toBe("manual_intake");
  });

  it("records a referral by NAME when the referrer is not in the CRM", () => {
    ingestLeadEvent(
      db,
      salesPhoneLead({
        referredBy: { name: "Juan Pérez", phone: "+5215599999999" },
      }),
    );
    const a = acct(db, "+5215512345678");
    expect(a.referred_by_name).toBe("Juan Pérez");
    expect(a.referred_by_phone).toBe("+5215599999999");
    expect(a.referred_by_account_id).toBeNull();
  });

  it("links a referral by accountKey when the referrer IS a known account", () => {
    ingestLeadEvent(
      db,
      salesPhoneLead({ accountKey: "ref-salon", name: "Salón Referidor" }),
    );
    const referrer = acct(db, "ref-salon");
    ingestLeadEvent(
      db,
      salesPhoneLead({ referredBy: { accountKey: "ref-salon" } }),
    );
    const a = acct(db, "+5215512345678");
    expect(a.referred_by_account_id).toBe(referrer.id);
    expect(a.referred_by_name).toBeNull();
  });

  it("when both an FK referrer and free text are given, the FK wins (free text dropped)", () => {
    ingestLeadEvent(
      db,
      salesPhoneLead({ accountKey: "ref-salon", name: "Referidor" }),
    );
    const referrer = acct(db, "ref-salon");
    ingestLeadEvent(
      db,
      salesPhoneLead({
        referredBy: {
          accountKey: "ref-salon",
          name: "Also Typed",
          phone: "+5215500000000",
        },
      }),
    );
    const a = acct(db, "+5215512345678");
    expect(a.referred_by_account_id).toBe(referrer.id);
    expect(a.referred_by_name).toBeNull();
    expect(a.referred_by_phone).toBeNull();
  });

  it("keeps an unresolved referrer key as a name rather than dropping it", () => {
    ingestLeadEvent(
      db,
      salesPhoneLead({ referredBy: { accountKey: "ghost-account" } }),
    );
    const a = acct(db, "+5215512345678");
    expect(a.referred_by_account_id).toBeNull();
    expect(a.referred_by_name).toBe("ghost-account");
  });

  it("treats provenance (source + referred_by) as set-once / immutable", () => {
    ingestLeadEvent(
      db,
      salesPhoneLead({ referredBy: { name: "First Referrer" } }),
    );
    // a later event for the same account must NOT rewrite how it first arrived
    ingestLeadEvent(
      db,
      salesPhoneLead({
        source: "denue",
        referredBy: { name: "Second Referrer" },
        type: "call",
        channel: "voice",
        direction: "outbound",
      }),
    );
    const a = acct(db, "+5215512345678");
    expect(a.source).toBe("sales_phone");
    expect(a.referred_by_name).toBe("First Referrer");
  });

  it("backfills a blank name but never overwrites an existing one", () => {
    ingestLeadEvent(db, salesPhoneLead({ name: undefined }));
    expect(acct(db, "+5215512345678").name).toBeNull();
    ingestLeadEvent(db, salesPhoneLead({ name: "Now Named" }));
    expect(acct(db, "+5215512345678").name).toBe("Now Named");
    ingestLeadEvent(db, salesPhoneLead({ name: "Different" }));
    expect(acct(db, "+5215512345678").name).toBe("Now Named");
  });

  it("records a qualification and advances the stage to qualified", () => {
    const r = ingestLeadEvent(
      db,
      salesPhoneLead({
        type: "qualified",
        qualification: {
          interested: true,
          fit: "takes appointments",
          score: 80,
        },
      }),
    );
    expect(r.stage).toBe("qualified");
    const a = acct(db, "+5215512345678");
    const q = db
      .prepare("SELECT * FROM qualification WHERE account_id = ?")
      .get(a.id) as {
      interested: number;
      score: number;
      source_interaction_id: string;
    };
    expect(q.interested).toBe(1);
    expect(q.score).toBe(80);
    expect(q.source_interaction_id).toBe(r.interactionId);
  });

  it("never regresses the stage on a later lower-rank event", () => {
    ingestLeadEvent(db, salesPhoneLead({ type: "qualified" }));
    const r = ingestLeadEvent(db, salesPhoneLead({ type: "manual_intake" }));
    expect(r.stage).toBe("qualified");
  });

  it("accrues cost per interaction (the CPQL numerator)", () => {
    ingestLeadEvent(db, salesPhoneLead({ costCents: 250 }));
    ingestLeadEvent(
      db,
      salesPhoneLead({
        type: "call",
        channel: "voice",
        direction: "outbound",
        costCents: 100,
      }),
    );
    const a = acct(db, "+5215512345678");
    const { total } = db
      .prepare(
        "SELECT COALESCE(SUM(cost_cents),0) total FROM interaction WHERE account_id = ?",
      )
      .get(a.id) as { total: number };
    expect(total).toBe(350);
  });

  it("honors an explicit occurredAt and defaults to datetime('now') otherwise", () => {
    ingestLeadEvent(db, salesPhoneLead({ occurredAt: "2025-01-01 08:30:00" }));
    const a = acct(db, "+5215512345678");
    const rows = db
      .prepare("SELECT occurred_at FROM interaction WHERE account_id = ?")
      .all(a.id) as { occurred_at: string }[];
    expect(rows[0]!.occurred_at).toBe("2025-01-01 08:30:00");

    ingestLeadEvent(
      db,
      salesPhoneLead({
        accountKey: "k2",
        type: "call",
        channel: "voice",
        direction: "outbound",
      }),
    );
    const a2 = acct(db, "k2");
    const r2 = db
      .prepare("SELECT occurred_at FROM interaction WHERE account_id = ?")
      .get(a2.id) as { occurred_at: string };
    expect(r2.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("writes attributes to the account vertical bag, set-once", () => {
    ingestLeadEvent(
      db,
      salesPhoneLead({ attributes: { colonia: "Centro", scian: "812110" } }),
    );
    const a = acct(db, "+5215512345678");
    expect(JSON.parse(a.attributes!)).toEqual({
      colonia: "Centro",
      scian: "812110",
    });
    // a later event must not overwrite the vertical bag (set-once provenance)
    ingestLeadEvent(
      db,
      salesPhoneLead({
        type: "call",
        channel: "voice",
        direction: "outbound",
        attributes: { colonia: "Otra" },
      }),
    );
    expect(JSON.parse(acct(db, "+5215512345678").attributes!).colonia).toBe(
      "Centro",
    );
  });

  it("dedups a contact by (account, phone) across events", () => {
    ingestLeadEvent(
      db,
      salesPhoneLead({ contact: { name: "Owner", phone: "+5215512345678" } }),
    );
    ingestLeadEvent(
      db,
      salesPhoneLead({
        type: "call",
        channel: "voice",
        direction: "outbound",
        contact: { name: "Owner", phone: "+5215512345678", role: "Dueño" },
      }),
    );
    const a = acct(db, "+5215512345678");
    const { n } = db
      .prepare("SELECT COUNT(*) n FROM contact WHERE account_id = ?")
      .get(a.id) as { n: number };
    expect(n).toBe(1);
  });

  it("a dnc event latches account.dnc=1 WITHOUT advancing the stage", () => {
    const r = ingestLeadEvent(
      db,
      salesPhoneLead({
        type: "dnc",
        outcome: "dnc",
        dnc: true,
        channel: "voice",
        direction: "outbound",
      }),
    );
    expect(r.stage).toBe("new"); // suppressed — NOT advanced into the active pipeline
    expect(acct(db, "+5215512345678").dnc).toBe(1);
  });

  it("latches dnc on a later event for a known account (compliance is NOT set-once)", () => {
    ingestLeadEvent(db, salesPhoneLead()); // account exists, dnc defaults 0
    expect(acct(db, "+5215512345678").dnc).toBe(0);
    ingestLeadEvent(
      db,
      salesPhoneLead({
        type: "dnc",
        dnc: true,
        channel: "voice",
        direction: "outbound",
      }),
    );
    expect(acct(db, "+5215512345678").dnc).toBe(1);
  });

  it("a redelivered refId is an exactly-once no-op (no second interaction, no double cost)", () => {
    const first = ingestLeadEvent(
      db,
      salesPhoneLead({
        type: "call",
        channel: "voice",
        direction: "outbound",
        refId: "ca-1",
        costCents: 100,
      }),
    );
    const second = ingestLeadEvent(
      db,
      salesPhoneLead({
        type: "call",
        channel: "voice",
        direction: "outbound",
        refId: "ca-1",
        costCents: 100,
      }),
    );
    expect(second.created).toBe(false);
    expect(second.interactionId).toBe(first.interactionId);
    const a = acct(db, "+5215512345678");
    const { n, total } = db
      .prepare(
        "SELECT COUNT(*) n, COALESCE(SUM(cost_cents),0) total FROM interaction WHERE account_id = ?",
      )
      .get(a.id) as { n: number; total: number };
    expect(n).toBe(1); // only one interaction row
    expect(total).toBe(100); // cost not doubled
  });

  it("does NOT dedup ref_id-less events (each logs its own interaction)", () => {
    ingestLeadEvent(db, salesPhoneLead()); // no refId
    ingestLeadEvent(
      db,
      salesPhoneLead({ type: "call", channel: "voice", direction: "outbound" }),
    );
    const a = acct(db, "+5215512345678");
    const { n } = db
      .prepare("SELECT COUNT(*) n FROM interaction WHERE account_id = ?")
      .get(a.id) as { n: number };
    expect(n).toBe(2);
  });
});
