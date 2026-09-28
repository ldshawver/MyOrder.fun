import { describe, expect, it } from "vitest";
import { recommendReplenishment } from "../cataloguePolicy";

describe("replenishment recommendations", () => {
  it("uses exact quantities, offers an internal move first, then applies preferred quantity and MOQ", () => {
    const plan = recommendReplenishment([
      { locationId: 1, name: "Storefront", available: "1.000001", par: "5.000000", reorderPoint: "2.000000", preferredReorderQuantity: "2.500000", moq: "3.000000", eligible: true },
      { locationId: 2, name: "Backstock", available: "7.500002", par: "6.000000", reorderPoint: "1.000000", preferredReorderQuantity: "0", moq: "0", eligible: true },
    ]);
    expect(plan[0]).toMatchObject({
      internalTransfers: [{ fromLocationId: 2, quantity: "1.500002" }],
      externalPurchaseQuantity: "3.000000",
    });
    expect(plan[1].externalPurchaseQuantity).toBe("0.000000");
  });

  it("does not recommend transfers from an ineligible or below PAR location", () => {
    const plan = recommendReplenishment([
      { locationId: 1, name: "A", available: "0", par: "5", reorderPoint: "1", preferredReorderQuantity: "4", moq: "6", eligible: true },
      { locationId: 2, name: "B", available: "9", par: "2", reorderPoint: "1", preferredReorderQuantity: "0", moq: "0", eligible: false },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0].internalTransfers).toEqual([]);
    expect(plan[0].externalPurchaseQuantity).toBe("6.000000");
  });
});
