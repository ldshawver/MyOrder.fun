import { describe, expect, it } from "vitest";
import { checkoutPreparationError } from "../checkoutMappingFeedback";

describe("checkout mapping feedback", () => {
  it("identifies the blocked cart item without treating a missing mapping as purchasable", () => {
    expect(checkoutPreparationError(
      { code: "CHECKOUT_MAPPING_REQUIRED", catalogItemId: 42, error: "Missing safe checkout fields" },
      [{ id: 42, name: "Verified catalog item" }],
    )).toBe("Verified catalog item needs verified checkout details before it can be purchased. Remove it from your cart or contact the store.");
  });

  it("does not disclose a cross-cart item name", () => {
    expect(checkoutPreparationError(
      { code: "CHECKOUT_MAPPING_REQUIRED", catalogItemId: 99 },
      [{ id: 42, name: "Different cart item" }],
    )).toContain("This item needs verified checkout details");
  });
});
