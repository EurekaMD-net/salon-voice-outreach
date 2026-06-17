import { describe, it, expect } from "vitest";
import { advanceStage, impliedStage } from "../src/stage.js";

describe("stage logic (forward-only, terminal-safe)", () => {
  it("advances forward to a higher-rank stage", () => {
    expect(advanceStage("new", "contacted")).toBe("contacted");
    expect(advanceStage("contacted", "qualified")).toBe("qualified");
    expect(advanceStage("qualified", "engaged_inbound")).toBe(
      "engaged_inbound",
    );
  });

  it("never regresses to a lower-rank stage", () => {
    expect(advanceStage("qualified", "contacted")).toBe("qualified");
    expect(advanceStage("engaged_inbound", "new")).toBe("engaged_inbound");
  });

  it("stays terminal once won/lost (no auto transition out)", () => {
    expect(advanceStage("won", "engaged_inbound")).toBe("won");
    expect(advanceStage("lost", "qualified")).toBe("lost");
    // won and lost share rank — never auto-swap one for the other
    expect(advanceStage("won", "lost")).toBe("won");
    expect(advanceStage("lost", "won")).toBe("lost");
  });

  it("maps known event types to their implied stage", () => {
    expect(impliedStage("manual_intake")).toBe("contacted");
    expect(impliedStage("call")).toBe("contacted");
    expect(impliedStage("referral")).toBe("new");
    expect(impliedStage("qualified")).toBe("qualified");
    expect(impliedStage("optin_sent")).toBe("handed_off");
    expect(impliedStage("inbound")).toBe("engaged_inbound");
    expect(impliedStage("won")).toBe("won");
    expect(impliedStage("lost")).toBe("lost");
  });

  it("returns null for an event type that doesn't move the stage", () => {
    expect(impliedStage("note")).toBeNull();
    expect(impliedStage("something_new")).toBeNull();
  });
});
