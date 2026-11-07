import { describe, expect, it } from "vitest";
import { hourInBusinessZone, hourLabel, inventoryRollup, suggestedOrderLines, weekdayInBusinessZone, type StockLocationRow } from "../reportSeries";

const stock = (patch: Partial<StockLocationRow>): StockLocationRow => ({
  inventoryItemId: 1,
  productName: "Red Brick",
  optionLabel: "Standard",
  locationId: 1,
  locationName: "Backstock",
  onHand: "10.000000",
  available: "10.000000",
  par: "0.000000",
  reorderPoint: "0.000000",
  preferredReorderQuantity: "0.000000",
  moq: "0.000000",
  eligible: true,
  ...patch,
});

describe("report series", () => {
  it("labels hours and buckets them in Pacific time", () => {
    expect(hourLabel(0)).toBe("12 AM");
    expect(hourLabel(13)).toBe("1 PM");
    expect(hourInBusinessZone(new Date("2026-11-04T09:26:17.000Z"))).toBe(1);
    expect(weekdayInBusinessZone(new Date("2026-11-04T09:26:17.000Z"))).toBe(3);
  });

  it("adds stock across locations for one product", () => {
    const rows = inventoryRollup([
      stock({ locationId: 1, onHand: "4.000000", available: "3.500000" }),
      stock({ locationId: 2, locationName: "Storefront", onHand: "1.000000", available: "1.000000" }),
      stock({ inventoryItemId: 2, productName: "Tina", optionLabel: "Ball Tina", onHand: "7.000000", available: "7.000000" }),
    ]);
    expect(rows[0]).toMatchObject({ name: "Tina — Ball Tina", available: "7.000000" });
    expect(rows[1]).toMatchObject({ name: "Red Brick", onHand: "5.000000", available: "4.500000", locations: 2 });
  });

  it("suggests a purchase only where stock is at the reorder point, and a transfer when another location has extra", () => {
    const lines = suggestedOrderLines([
      stock({ locationId: 1, locationName: "Storefront", available: "1.000000", par: "5.000000", reorderPoint: "2.000000", preferredReorderQuantity: "4.000000", moq: "0.000000" }),
      stock({ locationId: 2, locationName: "Backstock", available: "8.000000", par: "6.000000", reorderPoint: "1.000000" }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      product: "Red Brick",
      location: "Storefront",
      transfer: "2.000000 from Backstock",
      orderQuantity: "4.000000",
    });
  });
});
