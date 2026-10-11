import { describe, expect, it } from "vitest";
import { mapWooSellingPrice } from "../wooPricing";

describe("Woo effective selling price mapping", () => {
  it("uses the current sale price and preserves regular price only as compare-at", () => {
    expect(mapWooSellingPrice({ price: "9.00", regularPrice: "10.99", salePrice: "9.00", currency: "USD" }))
      .toEqual({ price: "9.00", compareAtPrice: "10.99" });
  });

  it("does not treat a non-sale regular price as compare-at", () => {
    expect(mapWooSellingPrice({ price: "10", regularPrice: "10.00", currency: "USD" }))
      .toEqual({ price: "10.00", compareAtPrice: null });
  });

  it("rounds decimal precision without binary floating point and rejects missing or malformed prices", () => {
    expect(mapWooSellingPrice({ price: "1.235", currency: "USD" }).price).toBe("1.24");
    expect(() => mapWooSellingPrice({ price: "", currency: "USD" })).toThrow("woo_price_missing_or_invalid");
    expect(() => mapWooSellingPrice({ price: "1e3", currency: "USD" })).toThrow("woo_price_missing_or_invalid");
    expect(() => mapWooSellingPrice({ price: "1.00", currency: "US" })).toThrow("unsupported_currency_configuration");
  });
});
