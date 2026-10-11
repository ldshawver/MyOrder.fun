import { describe, expect, it } from "vitest";
import { physicalQuantityForReturnedUnits, planReturnRestoration } from "../returnInventory";

describe("variation return inventory restoration", () => {
  it("restores multiplier quantities to the original sale locations", () => {
    const sales = [
      { movementId: 11, catalogItemId: 400, locationId: 2, quantity: "4.000000" },
      { movementId: 12, catalogItemId: 400, locationId: 5, quantity: "6.000000" },
    ];
    expect(physicalQuantityForReturnedUnits("10.000000", 2, 1)).toBe("5.000000");
    expect(planReturnRestoration("5", sales, [])).toEqual([
      { ...sales[0], restoreQuantity: "4.000000" },
      { ...sales[1], restoreQuantity: "1.000000" },
    ]);
    expect(planReturnRestoration("3", sales, [{ saleMovementId: 11, quantity: "4" }])).toEqual([
      { ...sales[1], restoreQuantity: "3.000000" },
    ]);
  });
  it("fails closed when return restoration exceeds original sale allocations", () => {
    expect(() => planReturnRestoration("2", [{ movementId: 1, catalogItemId: 9, locationId: 1, quantity: "1" }], [])).toThrow(/exceeds original/);
    expect(() => physicalQuantityForReturnedUnits("1.000001", 2, 1)).toThrow(/exact per-unit/);
  });
});
