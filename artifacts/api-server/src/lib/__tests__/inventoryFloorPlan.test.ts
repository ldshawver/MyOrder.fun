import { describe, expect, it } from "vitest";
import {
  FLOOR_LOCAL_CATALOG_SQL,
  buildCountStops,
  buildFloorSheet,
  canonicalizeFloorDecimal,
  compareFloorQuantity,
  floorQuantityFitsBalance,
  countCheer,
  floorIdempotencyKey,
  nextStopIndex,
  openingUnitCost,
  planPhysicalCount,
  subtractFloorQuantity,
  summarizeFloorLines,
  valuationCanFundIncrease,
  walkLocationIds,
  type FloorLocation,
  type RawFloorProduct,
} from "../inventoryFloorPlan";

const locations: FloorLocation[] = [
  { id: 1, name: "Backstock", type: "backstock", displayOrder: 1 },
  { id: 2, name: "Storefront", type: "storefront", displayOrder: 2 },
  { id: 4, name: "CSR Sales Box 2", type: "csr_box", displayOrder: 4 },
  { id: 3, name: "CSR Sales Box 1", type: "csr_box", displayOrder: 3 },
];

function product(patch: Partial<RawFloorProduct> & Pick<RawFloorProduct, "itemId" | "name">): RawFloorProduct {
  return {
    entityType: "catalog",
    subtitle: null,
    unit: "#",
    category: "Flower",
    special: false,
    costCandidates: [],
    balances: [],
    ...patch,
  };
}

describe("inventory floor plan", () => {
  it("accepts the quantities a person would type", () => {
    expect(canonicalizeFloorDecimal("03")).toBe("3");
    expect(canonicalizeFloorDecimal("3.50")).toBe("3.5");
    expect(canonicalizeFloorDecimal("1.")).toBe("1");
    expect(canonicalizeFloorDecimal("0")).toBe("0");
    expect(canonicalizeFloorDecimal("")).toBeNull();
    expect(canonicalizeFloorDecimal("1e2")).toBeNull();
    expect(canonicalizeFloorDecimal("-2")).toBeNull();
    expect(floorQuantityFitsBalance("catalog", "1.123456")).toBe(true);
    expect(floorQuantityFitsBalance("catalog", "1.1234567")).toBe(false);
    expect(floorQuantityFitsBalance("non_catalog", "9999999.5")).toBe(true);
    expect(floorQuantityFitsBalance("non_catalog", "10000000")).toBe(false);
    expect(floorQuantityFitsBalance("non_catalog", "1.2345")).toBe(false);
  });

  it("compares and subtracts without using binary floats", () => {
    expect(compareFloorQuantity("3.50", "3.5")).toBe(0);
    expect(compareFloorQuantity("10", "9")).toBe(1);
    expect(subtractFloorQuantity("12.5", "10")).toBe("2.5");
    expect(subtractFloorQuantity("3", "3.5")).toBe("-0.5");
  });

  it("plans a count as an opening, a match, or a correction", () => {
    expect(planPhysicalCount(null, "0")).toEqual({ action: "opening", quantity: "0", needsUnitCost: false });
    expect(planPhysicalCount(null, "4")).toEqual({ action: "opening", quantity: "4", needsUnitCost: true });
    expect(planPhysicalCount("12.000", "12")).toEqual({ action: "unchanged" });
    expect(planPhysicalCount("3.50", "3.5")).toEqual({ action: "unchanged" });
    expect(planPhysicalCount("12", "10")).toEqual({ action: "correction", direction: "decrease", quantity: "2" });
    expect(planPhysicalCount("12", "15")).toEqual({ action: "correction", direction: "increase", quantity: "3" });
  });

  it("asks for a cost only when stock value is not already known", () => {
    expect(valuationCanFundIncrease("known", "4.50")).toBe(true);
    expect(valuationCanFundIncrease("known", "0")).toBe(false);
    expect(valuationCanFundIncrease("unknown_baseline", "4")).toBe(false);
    expect(openingUnitCost("8", "4", "2")).toBe("8");
    expect(openingUnitCost(null, "4.00", "2")).toBe("4");
    expect(openingUnitCost("", null, "0")).toBeNull();
  });

  it("walks every location from the chosen start, or stays on one", () => {
    expect(walkLocationIds([1, 2, 3, 4], 3, "all")).toEqual([3, 4, 1, 2]);
    expect(walkLocationIds([1, 2, 3, 4], 3, "one")).toEqual([3]);
    expect(walkLocationIds([1, 2, 3, 4], 9, "all")).toEqual([]);
  });

  it("leaves package specials off the count and keeps real items at every spot", () => {
    const sheet = buildFloorSheet(locations, [
      product({ itemId: 440, name: "Slut Special", special: true, category: "Specials" }),
      product({ itemId: 14, name: "Red Brick", balances: [{ locationId: 2, quantity: "12.000000" }] }),
      product({ itemId: 10, name: "1 oz BDO", category: "Water", balances: [] }),
    ]);
    expect(sheet.map(item => item.name)).toEqual(["Red Brick", "1 oz BDO"]);
    const stops = buildCountStops(sheet, locations, 2, "all");
    expect(stops.map(stop => stop.locationName)).toEqual([
      "Storefront", "Storefront",
      "CSR Sales Box 1", "CSR Sales Box 1",
      "CSR Sales Box 2", "CSR Sales Box 2",
      "Backstock", "Backstock",
    ]);
    const storefrontBrick = stops.find(stop => stop.locationId === 2 && stop.itemId === 14);
    expect(storefrontBrick).toMatchObject({ hasBalance: true, bookQuantity: "12.000000" });
    expect(stops.find(stop => stop.itemId === 10 && stop.locationId === 1)).toMatchObject({ hasBalance: false, bookQuantity: null });
    expect(stops.some(stop => stop.name === "Slut Special")).toBe(false);
  });

  it("resumes after the items already logged and keeps the latest note of a recount", () => {
    const stops = [{ locationId: 2, entityType: "catalog", itemId: 14 }, { locationId: 2, entityType: "catalog", itemId: 10 }];
    expect(nextStopIndex(stops, [{ locationId: 2, entityType: "catalog", itemId: 14 }])).toBe(1);
    expect(nextStopIndex(stops, [{ locationId: 2, entityType: "catalog", itemId: 14 }, { locationId: 2, entityType: "catalog", itemId: 10 }])).toBe(2);
    expect(summarizeFloorLines([
      { locationId: 2, entityType: "catalog", itemId: 14, attempt: 1, outcome: "skipped" },
      { locationId: 2, entityType: "catalog", itemId: 14, attempt: 2, outcome: "corrected" },
      { locationId: 2, entityType: "catalog", itemId: 10, attempt: 1, outcome: "unchanged" },
    ])).toMatchObject({ corrected: 1, unchanged: 1, skipped: 0 });
    expect(countCheer(0, 4)).toBe("First one. You've got this.");
    expect(countCheer(3, 4)).toBe("Last one.");
    expect(floorIdempotencyKey("count", 12, 2, "catalog", 14, 1).length).toBeLessThanOrEqual(120);
  });

  it("counts the same local catalogue rows the inventory list uses", () => {
    expect(FLOOR_LOCAL_CATALOG_SQL).toContain("ci.is_local_alavont = true");
    expect(FLOOR_LOCAL_CATALOG_SQL).toContain("safeOnlyDuplicate");
    expect(FLOOR_LOCAL_CATALOG_SQL).toContain("archived");
    expect(FLOOR_LOCAL_CATALOG_SQL).not.toMatch(/category/i);
  });
});
