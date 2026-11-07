import { describe, expect, it } from "vitest";
import { shiftOpeningQuantity } from "../shiftOpeningQuantity";

describe("shiftOpeningQuantity", () => {
  it("uses the live box balance instead of a stale template or typed count", () => {
    expect(shiftOpeningQuantity({ liveOnHand: 24, confirmedCount: 0, templateDefault: 0 })).toBe(24);
    expect(shiftOpeningQuantity({ liveOnHand: 0, confirmedCount: 5, templateDefault: 1 })).toBe(0);
  });

  it("keeps a confirmed count when the box has no balance row", () => {
    expect(shiftOpeningQuantity({ liveOnHand: null, confirmedCount: 10, templateDefault: 0 })).toBe(10);
    expect(shiftOpeningQuantity({ confirmedCount: null, templateDefault: 3 })).toBe(3);
  });
});
