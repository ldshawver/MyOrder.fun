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

  it("matches the accepted Coffee Beans quantities without performing a movement", () => {
    const plan = recommendReplenishment([
      { locationId: 1, name: "Backstock", available: "2500.000000", par: "5000", reorderPoint: "3500",
        preferredReorderQuantity: "2000", moq: "1000", eligible: true },
      { locationId: 2, name: "Storefront", available: "2000.000000", par: "1000", reorderPoint: "500",
        preferredReorderQuantity: "1000", moq: "500", eligible: true },
    ]);
    expect(plan[0]).toEqual({
      locationId: 1, locationName: "Backstock", available: "2500.000000",
      internalTransfers: [{ fromLocationId: 2, quantity: "1000.000000" }],
      externalPurchaseQuantity: "2000.000000",
    });
    expect(plan[1].internalTransfers).toEqual([]);
    expect(plan[1].externalPurchaseQuantity).toBe("0.000000");
  });

  it("uses one aggregate reorder threshold for combined locations and reports a deterministic destination", () => {
    const plan = recommendReplenishment([
      { locationId: 2, name: "Backstock", available: "3.250000", par: "5", reorderPoint: "4", preferredReorderQuantity: "2", moq: "1", eligible: true },
      { locationId: 1, name: "Storefront", available: "2.250000", par: "5", reorderPoint: "4", preferredReorderQuantity: "1", moq: "2", eligible: true },
      { locationId: 3, name: "Inactive", available: "99", par: "99", reorderPoint: "99", preferredReorderQuantity: "99", moq: "99", eligible: false },
    ], "COMBINED_LOCATIONS", 1);
    expect(plan).toEqual([{ locationId: 1, locationName: "Storefront", available: "5.500000", internalTransfers: [], externalPurchaseQuantity: "4.500000" }]);
  });
});
