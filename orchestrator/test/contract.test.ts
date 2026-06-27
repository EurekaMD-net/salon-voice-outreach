import { describe, it, expect } from "vitest";
import { buildCrmEvent, type CrmSyncRow } from "../src/crm-event.js";
import type { Disposition } from "../src/types.js";
import { validateLeadEvent } from "vlcrm";

/**
 * CROSS-SERVICE CONTRACT TEST (the seam the outbox poison-pill would live in).
 *
 * The orchestrator emits a LOCAL `CrmLeadEvent`; vlcrm's `validateLeadEvent` is the
 * single enforcement point. The "#1 contract check" was originally a MANUAL reasoning
 * pass — so a field rename / enum tighten / nullability change on either side would
 * 400 in production while both unit suites stayed green (audit-gate finding #6). This
 * runs the real producer output through the real consumer validator, mechanically.
 *
 * vlcrm now lives in its own repo (EurekaMD-net/vlcrm); the consumer-side validator is
 * imported from the `vlcrm` package (git devDependency). This test belongs here — at
 * the orchestrator (the consumer/producer of the seam) — not inside vlcrm, which is
 * channel-agnostic and knows nothing about this producer.
 *
 * NOTE: this validates against the vlcrm version PINNED in package-lock, not the live
 * deployed service. Drift on vlcrm's `main` only surfaces here after `npm update vlcrm`.
 */

// buildCrmEvent only reads voiceCostPerMinuteCents (via callCostCents).
const cfg = { voiceCostPerMinuteCents: 3 } as Parameters<
  typeof buildCrmEvent
>[1];

const DISPOSITIONS: Disposition[] = [
  "no_answer",
  "voicemail",
  "connected",
  "qualified",
  "declined",
  "dnc",
  "failed",
];

const rowFor = (disposition: Disposition): CrmSyncRow => ({
  call_attempt_id: "ca-1",
  campaign_id: "camp-1",
  pipesong_call_id: "ps-1",
  disposition,
  duration_s: 90,
  phone_e164: "+5215512345678",
  name: "Salón Demo",
  colonia: "Iztapalapa",
  ig_handle: "@demo",
  source: "denue-iztapalapa-2026-06",
});

describe("contract: buildCrmEvent → validateLeadEvent", () => {
  for (const d of DISPOSITIONS) {
    it(`a '${d}' event passes vlcrm's validator + round-trips its fields`, () => {
      const event = buildCrmEvent(rowFor(d), cfg);
      expect(() => validateLeadEvent(event)).not.toThrow();
      const v = validateLeadEvent(event);
      expect(v.accountKey).toBe(event.accountKey);
      expect(v.channel).toBe(event.channel);
      expect(v.direction).toBe(event.direction);
      expect(v.type).toBe(event.type);
      expect(v.source).toBe(event.source);
      expect(v.outcome).toBe(event.outcome);
      expect(v.qualification?.interested).toBe(event.qualification?.interested);
    });
  }

  it("the dnc suppression flag survives the round-trip", () => {
    const event = buildCrmEvent(rowFor("dnc"), cfg);
    expect(event.dnc).toBe(true);
    expect(validateLeadEvent(event).dnc).toBe(true);
  });

  it("a minimal event (all optional prospect fields null) still validates", () => {
    const event = buildCrmEvent(
      {
        ...rowFor("no_answer"),
        name: null,
        colonia: null,
        ig_handle: null,
        pipesong_call_id: null,
        duration_s: null,
      },
      cfg,
    );
    expect(() => validateLeadEvent(event)).not.toThrow();
  });
});
