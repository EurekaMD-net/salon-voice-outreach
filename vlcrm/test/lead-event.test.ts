import { describe, it, expect } from "vitest";
import { validateLeadEvent, LeadEventError } from "../src/lead-event.js";

const base = {
  accountKey: "k",
  channel: "sales_phone",
  direction: "inbound",
  type: "manual_intake",
};

describe("validateLeadEvent — the fail-closed ingest boundary", () => {
  it("accepts a minimal valid event", () => {
    const ev = validateLeadEvent({ ...base });
    expect(ev.accountKey).toBe("k");
    expect(ev.channel).toBe("sales_phone");
  });

  it("throws on a non-object input", () => {
    expect(() => validateLeadEvent(null)).toThrow(LeadEventError);
    expect(() => validateLeadEvent("nope")).toThrow(LeadEventError);
  });

  it("throws on missing required fields", () => {
    expect(() => validateLeadEvent({ ...base, accountKey: "" })).toThrow(
      /accountKey/,
    );
    expect(() => validateLeadEvent({ ...base, type: undefined })).toThrow(
      /type/,
    );
  });

  it("throws on a bad channel / direction / source enum (never coerces)", () => {
    expect(() => validateLeadEvent({ ...base, channel: "pigeon" })).toThrow(
      /channel/,
    );
    expect(() => validateLeadEvent({ ...base, direction: "sideways" })).toThrow(
      /direction/,
    );
    expect(() => validateLeadEvent({ ...base, source: "bogus" })).toThrow(
      /source/,
    );
  });

  it("throws on a non-integer or negative costCents", () => {
    expect(() => validateLeadEvent({ ...base, costCents: -1 })).toThrow(
      /costCents/,
    );
    expect(() => validateLeadEvent({ ...base, costCents: 1.5 })).toThrow(
      /costCents/,
    );
    expect(validateLeadEvent({ ...base, costCents: 40 }).costCents).toBe(40);
  });

  it("rejects a fractional qualification.score (INTEGER column)", () => {
    expect(() =>
      validateLeadEvent({ ...base, qualification: { score: 80.5 } }),
    ).toThrow(/score must be an integer/);
    expect(
      validateLeadEvent({ ...base, qualification: { score: 80 } }).qualification
        ?.score,
    ).toBe(80);
  });

  it("rejects a non-boolean qualification.interested", () => {
    expect(() =>
      validateLeadEvent({ ...base, qualification: { interested: "yes" } }),
    ).toThrow(/interested/);
  });

  it("passes referredBy / contact through when well-formed", () => {
    const ev = validateLeadEvent({
      ...base,
      referredBy: { name: "Pedro", phone: "+521" },
      contact: { name: "María", role: "Dueña" },
    });
    expect(ev.referredBy?.name).toBe("Pedro");
    expect(ev.contact?.role).toBe("Dueña");
  });
});
