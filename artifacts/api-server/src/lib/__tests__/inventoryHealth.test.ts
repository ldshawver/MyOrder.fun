import { describe, expect, it } from "vitest";
import { classifyInventoryBalance } from "../inventoryHealth";

describe("inventory health classification", () => {
  const balance = { inventoryKind: "sellable", isSellable: true };
  const product = { id: 1, isAvailable: true };
  const location = { id: 2, isActive: true };

  it("classifies valid sellable balances as sellable catalog product", () => {
    expect(classifyInventoryBalance({ balance, product, location })).toBe("sellable_catalog_product");
  });

  it("classifies missing product and location as orphan balance", () => {
    expect(classifyInventoryBalance({ balance, product: null, location: null })).toBe("orphan_balance");
  });

  it("classifies missing product as invalid product", () => {
    expect(classifyInventoryBalance({ balance, product: null, location })).toBe("invalid_product");
  });

  it("classifies missing or inactive location as invalid location", () => {
    expect(classifyInventoryBalance({ balance, product, location: null })).toBe("invalid_location");
    expect(classifyInventoryBalance({ balance, product, location: { id: 2, isActive: false } })).toBe("invalid_location");
  });

  it("classifies non-sellable supply separately", () => {
    expect(classifyInventoryBalance({ balance: { inventoryKind: "non_sellable_supply", isSellable: false }, product, location })).toBe("non_sellable_supply");
  });
});
