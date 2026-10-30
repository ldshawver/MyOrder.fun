import { describe, expect, it } from "vitest";
import { applyAccountabilityOffsets, calculateShiftInventoryAccountability } from "../shiftInventoryAccountability";

const row = (overrides: Record<string, unknown> = {}) => ({
  shiftInventoryItemId: 7, catalogItemId: 41, locationId: 3, itemName: "Exact variant", unitOfMeasure: "each",
  openingQuantity: "10", recordedSalesQuantity: "2", nonSaleMovementDelta: "1", countedQuantity: "6", retailPrice: "12.50",
  ...overrides,
});

describe("shift inventory accountability", () => {
  it("uses opening plus non-sale ledger activity minus recorded sales and values only shortages at 80% of retail", () => {
    expect(calculateShiftInventoryAccountability([row()])).toEqual({ blockers: [], total: "30.00", lines: [expect.objectContaining({
      expectedQuantity: "9", countedQuantity: "6", missingQuantity: "3", retailPrice: "12.50",
      discountRate: "0.200000", replacementRate: "0.800000", unitReplacementValue: "10.00", lineTotal: "30.00",
    })] });
  });

  it("does not charge overages", () => {
    expect(calculateShiftInventoryAccountability([row({ countedQuantity: "10" })])).toEqual({ lines: [], blockers: [], total: "0.00" });
  });

  it("blocks missing counts, exact variants, locations, and retail prices", () => {
    const result = calculateShiftInventoryAccountability([
      row({ countedQuantity: null }), row({ shiftInventoryItemId: 8, catalogItemId: null }),
      row({ shiftInventoryItemId: 9, locationId: null }), row({ shiftInventoryItemId: 10, retailPrice: "0" }),
    ]);
    expect(result.blockers.map(item => item.code)).toEqual([
      "PHYSICAL_COUNT_REQUIRED", "CATALOG_ITEM_REQUIRED", "LOCATION_REQUIRED", "RETAIL_PRICE_REQUIRED",
    ]);
  });

  it("rounds fractional shortages deterministically and snapshots money", () => {
    const result = calculateShiftInventoryAccountability([row({ openingQuantity: "1.125", recordedSalesQuantity: "0", nonSaleMovementDelta: "0", countedQuantity: "0.625", retailPrice: "9.99" })]);
    expect(result.lines[0]).toMatchObject({ missingQuantity: "0.5", unitReplacementValue: "7.99", lineTotal: "4.00" });
  });

  it("applies offsets without exceeding payable and carries the audited remainder", () => {
    expect(applyAccountabilityOffsets("25.00", "10.00", "30.00")).toEqual({
      grossPayable: "25.00", priorOffsetApplied: "10.00", currentOffsetApplied: "15.00", netPayout: "0.00",
      priorRemainder: "0.00", currentRemainder: "15.00", totalRemainder: "15.00",
      remainderPolicy: "carry_forward_to_future_shift_payout",
    });
  });
});
