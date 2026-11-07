import { describe, expect, it } from "vitest";
import { expectedEndingQuantity } from "../shiftInventory";

describe("expectedEndingQuantity", () => {
  it("prefills checkout with the amount the shift should still have", () => {
    expect(expectedEndingQuantity({ quantityEnd: 7, quantityStart: 10, quantitySold: 1 })).toBe(7);
    expect(expectedEndingQuantity({ quantityEnd: null, quantityStart: 10, quantitySold: 3 })).toBe(7);
    expect(expectedEndingQuantity({ quantityStart: 0, quantitySold: 0 })).toBe(0);
  });
});
