import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { ingestLeadEvent } from "../src/ingest.js";
import { computeCpql } from "../src/cpql.js";
import type { LeadEvent } from "../src/lead-event.js";

const ev = (
  o: Partial<LeadEvent> & Pick<LeadEvent, "accountKey">,
): LeadEvent => ({
  channel: "voice",
  direction: "outbound",
  type: "call",
  ...o,
});

describe("computeCpql", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("reports null CPQL when there are no qualified leads (no div-by-zero)", () => {
    ingestLeadEvent(db, ev({ accountKey: "a", costCents: 100 }));
    const r = computeCpql(db);
    expect(r.overall.leads).toBe(1);
    expect(r.overall.qualified).toBe(0);
    expect(r.overall.costCents).toBe(100);
    expect(r.overall.cpqlCents).toBeNull();
  });

  it("computes CPQL = total spend / qualified leads", () => {
    // account a: 300¢ spend, qualified
    ingestLeadEvent(
      db,
      ev({ accountKey: "a", costCents: 200, source: "denue" }),
    );
    ingestLeadEvent(
      db,
      ev({
        accountKey: "a",
        type: "qualified",
        costCents: 100,
        qualification: { interested: true },
      }),
    );
    // account b: 200¢ spend, NOT qualified
    ingestLeadEvent(
      db,
      ev({ accountKey: "b", costCents: 200, source: "denue" }),
    );
    const r = computeCpql(db);
    expect(r.overall.qualified).toBe(1);
    expect(r.overall.costCents).toBe(500);
    expect(r.overall.cpqlCents).toBe(500); // 500 / 1
  });

  it("breaks down spend by channel", () => {
    ingestLeadEvent(
      db,
      ev({ accountKey: "a", channel: "voice", costCents: 100 }),
    );
    ingestLeadEvent(
      db,
      ev({ accountKey: "a", channel: "sms", type: "optin_sent", costCents: 5 }),
    );
    const byCh = Object.fromEntries(
      computeCpql(db).costByChannel.map((x) => [x.channel, x.costCents]),
    );
    expect(byCh["voice"]).toBe(100);
    expect(byCh["sms"]).toBe(5);
  });

  it("counts qualified leads by acquisition source", () => {
    ingestLeadEvent(
      db,
      ev({
        accountKey: "a",
        source: "denue",
        type: "qualified",
        qualification: { interested: true },
      }),
    );
    ingestLeadEvent(
      db,
      ev({
        accountKey: "b",
        source: "sales_phone",
        channel: "sales_phone",
        direction: "inbound",
        type: "qualified",
        qualification: { interested: true },
      }),
    );
    const bySrc = Object.fromEntries(
      computeCpql(db).qualifiedBySource.map((x) => [x.source, x.qualified]),
    );
    expect(bySrc["denue"]).toBe(1);
    expect(bySrc["sales_phone"]).toBe(1);
  });

  it("does not count interested=false as qualified (uses the verdict, not the stage)", () => {
    ingestLeadEvent(
      db,
      ev({
        accountKey: "a",
        type: "qualified",
        qualification: { interested: false },
      }),
    );
    expect(computeCpql(db).overall.qualified).toBe(0);
  });

  it("does NOT double-count cost when the same refId is re-delivered (exactly-once)", () => {
    // the orchestrator outbox is at-least-once: a crash between emit and mark
    // re-delivers the SAME refId. CPQL (SUM cost) must not inflate on the retry.
    const e = ev({
      accountKey: "a",
      type: "qualified",
      costCents: 100,
      refId: "ca-1",
      qualification: { interested: true },
    });
    ingestLeadEvent(db, e);
    ingestLeadEvent(db, e); // redelivery
    const r = computeCpql(db);
    expect(r.overall.qualified).toBe(1);
    expect(r.overall.costCents).toBe(100); // NOT 200
    expect(r.overall.cpqlCents).toBe(100);
  });
});
