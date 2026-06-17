import { describe, it, expect } from "vitest";
import { applyDisposition } from "../src/state-machine.js";
import type { Disposition } from "../src/types.js";

describe("applyDisposition — terminal/handoff dispositions", () => {
  it("qualified → qualified, no requeue", () => {
    expect(applyDisposition("qualified", 1, 2)).toEqual({
      nextState: "qualified",
      requeue: false,
    });
  });
  it("declined → declined, no requeue", () => {
    expect(applyDisposition("declined", 1, 2)).toEqual({
      nextState: "declined",
      requeue: false,
    });
  });
  it("dnc → dnc, no requeue", () => {
    expect(applyDisposition("dnc", 1, 2)).toEqual({
      nextState: "dnc",
      requeue: false,
    });
  });
  it("connected (unresolved) stays connected, no requeue", () => {
    expect(applyDisposition("connected", 1, 2)).toEqual({
      nextState: "connected",
      requeue: false,
    });
  });
});

describe("applyDisposition — retryable dispositions + the cap", () => {
  const retryable: Disposition[] = ["no_answer", "voicemail", "failed"];
  for (const d of retryable) {
    it(`${d} under the cap → requeue`, () => {
      expect(applyDisposition(d, 1, 2)).toEqual({
        nextState: "queued",
        requeue: true,
      });
    });
    it(`${d} at the cap → exhausted`, () => {
      expect(applyDisposition(d, 2, 2)).toEqual({
        nextState: "exhausted",
        requeue: false,
      });
    });
  }
  it("the cap is strict: attempts === maxAttempts exhausts (no 3rd dial)", () => {
    // maxAttempts=2 → after 2 placed calls, no_answer must NOT requeue.
    expect(applyDisposition("no_answer", 2, 2).requeue).toBe(false);
    expect(applyDisposition("no_answer", 1, 2).requeue).toBe(true);
  });
});
