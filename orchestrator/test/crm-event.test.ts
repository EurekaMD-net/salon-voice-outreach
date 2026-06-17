import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildCrmEvent,
  callCostCents,
  type CrmSyncRow,
} from "../src/crm-event.js";
import type { Disposition } from "../src/types.js";

const cfg = loadConfig({ VOICE_COST_PER_MINUTE_CENTS: "3" });

const row = (over: Partial<CrmSyncRow> = {}): CrmSyncRow => ({
  call_attempt_id: "ca-1",
  campaign_id: "camp-1",
  pipesong_call_id: "ps-1",
  disposition: "connected",
  duration_s: null,
  phone_e164: "+5215512345678",
  name: "Salón Demo",
  colonia: "Iztapalapa",
  ig_handle: "@demo",
  source: "denue-iztapalapa-2026-06",
  ...over,
});

describe("buildCrmEvent — disposition mapping", () => {
  it("qualified → type 'qualified' + interested:true", () => {
    const e = buildCrmEvent(row({ disposition: "qualified" }), cfg);
    expect(e.type).toBe("qualified");
    expect(e.qualification).toEqual({ interested: true });
    expect(e.outcome).toBe("qualified");
  });

  it("human-reached dispositions → 'call' (advances to contacted)", () => {
    for (const d of ["connected", "declined", "dnc"] as Disposition[]) {
      const e = buildCrmEvent(row({ disposition: d }), cfg);
      expect(e.type).toBe("call");
      expect(e.outcome).toBe(d);
      expect(e.qualification).toBeUndefined();
    }
  });

  it("no-human dispositions → 'call_attempt' (no stage advance)", () => {
    for (const d of ["no_answer", "voicemail", "failed"] as Disposition[]) {
      const e = buildCrmEvent(row({ disposition: d }), cfg);
      expect(e.type).toBe("call_attempt");
      expect(e.outcome).toBe(d);
    }
  });

  it("uses the E.164 phone as accountKey; channel/direction = voice/outbound", () => {
    const e = buildCrmEvent(row(), cfg);
    expect(e.accountKey).toBe("+5215512345678");
    expect(e.channel).toBe("voice");
    expect(e.direction).toBe("outbound");
    expect(e.refId).toBe("ca-1");
  });

  it("collapses the campaign list tag to the 'denue' enum, else 'other'", () => {
    expect(buildCrmEvent(row({ source: "denue-x" }), cfg).source).toBe("denue");
    expect(buildCrmEvent(row({ source: "walk-in" }), cfg).source).toBe("other");
  });

  it("puts colonia in attributes (account bag), ids in payload (interaction)", () => {
    const e = buildCrmEvent(row(), cfg);
    expect(e.attributes).toEqual({ colonia: "Iztapalapa" });
    expect(e.payload).toEqual({ campaignId: "camp-1", pipesongCallId: "ps-1" });
  });

  it("omits attributes when colonia is null", () => {
    expect(
      buildCrmEvent(row({ colonia: null }), cfg).attributes,
    ).toBeUndefined();
  });

  it("builds contact from name + phone + ig", () => {
    expect(buildCrmEvent(row(), cfg).contact).toEqual({
      name: "Salón Demo",
      phone: "+5215512345678",
      ig: "@demo",
    });
  });
});

describe("callCostCents", () => {
  it("is 0 when duration is unknown/zero", () => {
    expect(callCostCents(null, cfg)).toBe(0);
    expect(callCostCents(0, cfg)).toBe(0);
  });
  it("rounds up to whole minutes × the per-minute rate", () => {
    expect(callCostCents(1, cfg)).toBe(3); // 1 min × 3
    expect(callCostCents(60, cfg)).toBe(3); // 1 min × 3
    expect(callCostCents(61, cfg)).toBe(6); // 2 min × 3
  });
});
