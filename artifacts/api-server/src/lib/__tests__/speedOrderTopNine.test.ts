import { describe, expect, it } from "vitest";
import { defaultHasPermission } from "../roles";
import { acceptSpeedOrderPins, parseSpeedOrderPins, selectHybridTopNine, speedOrderSellableItem, type SpeedOrderCatalogItem } from "../speedOrderTopNine";

const catalog: SpeedOrderCatalogItem[] = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `Item ${index + 1}`, price: index + 1, imageUrl: null }));

describe("Speed Order Top Nine", () => {
  it("fills unpinned slots by paid 30-day units without duplicates", () => {
    const ranked = catalog.map((item, index) => ({ catalogItemId: item.id, units: 20 - index }));
    const slots = selectHybridTopNine({ ranked, pins: [{ slot: 2, catalogItemId: 10 }], catalog });
    expect(slots).toHaveLength(9);
    expect(slots[2]).toMatchObject({ source: "pin", catalogItemId: 10 });
    expect(new Set(slots.map(slot => slot.catalogItemId)).size).toBe(9);
    expect(slots.filter(slot => slot.source === "rank").map(slot => slot.catalogItemId)).not.toContain(10);
  });

  it("rejects duplicate and malformed manager pins", () => {
    expect(parseSpeedOrderPins([{ slot: 1, catalogItemId: 2 }, { slot: 1, catalogItemId: 3 }])).toEqual([{ slot: 1, catalogItemId: 2 }]);
    expect(acceptSpeedOrderPins({ pins: [{ slot: 1, catalogItemId: 2 }, { slot: 1, catalogItemId: 3 }] }).ok).toBe(false);
    expect(acceptSpeedOrderPins({ pins: [{ slot: 0, catalogItemId: 2 }, { slot: 2, catalogItemId: 2 }] }).ok).toBe(false);
  });

  it("uses the server checkout price and excludes unavailable catalog items", () => {
    const row = { id: 1, name: "Item", price: "25.00", regularPrice: "25.00", compareAtPrice: "19.99", metadata: { activeSale: true }, isAvailable: true };
    expect(speedOrderSellableItem(row)).toMatchObject({ price: 19.99 });
    expect(speedOrderSellableItem({ ...row, isAvailable: false })).toBeNull();
    expect(speedOrderSellableItem({ ...row, metadata: { archived: true } })).toBeNull();
  });

  it("grants use to CSR and pin management only to managers", () => {
    expect(defaultHasPermission("csr", "speed_order.use")).toBe(true);
    expect(defaultHasPermission("csr", "speed_order.pin")).toBe(false);
    expect(defaultHasPermission("supervisor", "speed_order.pin")).toBe(true);
    expect(defaultHasPermission("user", "speed_order.use")).toBe(false);
  });
});
