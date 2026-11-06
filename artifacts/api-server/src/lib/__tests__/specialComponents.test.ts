import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkoutComponentFromStock,
  displaySpecialComponents,
  formatRetailQuantity,
  groupSpecialReservationDemands,
  readSpecialComponentSnapshot,
  specialComponentSnapshot,
  specialIncludesNote,
  specialsAvailable,
  type CheckoutComponent,
  type ComponentStock,
} from "../specialComponents";

function stock(overrides: Partial<ComponentStock> = {}): ComponentStock {
  return {
    specialCatalogItemId: 90,
    catalogItemId: 1,
    productName: "Alpha",
    label: "Standard",
    quantity: "1",
    consumptionQuantity: "1",
    inventoryCatalogItemId: 1,
    inventoryItemId: 11,
    locationEvaluation: "COMBINED_LOCATIONS",
    balanceRowCount: 1,
    availableQuantity: "5.000000",
    maxLocationAvailable: "5.000000",
    active: true,
    productActive: true,
    isAvailable: true,
    isWooManaged: false,
    complianceHold: false,
    archived: false,
    visible: true,
    ...overrides,
  };
}

describe("special component availability", () => {
  it("sells only as many specials as the shortest component can cover", () => {
    const components = [
      stock({ catalogItemId: 1, productName: "Alpha", inventoryCatalogItemId: 1, availableQuantity: "5.000000" }),
      stock({ catalogItemId: 2, productName: "Beta", inventoryCatalogItemId: 2, inventoryItemId: 12, availableQuantity: "2.000000" }),
      stock({ catalogItemId: 3, productName: "Gamma", inventoryCatalogItemId: 3, inventoryItemId: 13, availableQuantity: "9.000000" }),
    ];
    expect(specialsAvailable(components, 1)).toMatchObject({ orderable: true, inventoryStatus: "ready", availableQuantity: "2.000000" });
    expect(specialsAvailable(components, 3).orderable).toBe(false);
  });

  it("blocks the special when any component has no sellable balance", () => {
    const verdict = specialsAvailable([
      stock(),
      stock({ catalogItemId: 2, inventoryCatalogItemId: 2, inventoryItemId: 12, balanceRowCount: 0, availableQuantity: null, maxLocationAvailable: null }),
    ], 1);
    expect(verdict).toMatchObject({ orderable: false, inventoryStatus: "missing_balance" });
  });

  it("uses the fullest single location when a component is evaluated per location", () => {
    const verdict = specialsAvailable([
      stock({ locationEvaluation: "PER_LOCATION", availableQuantity: "5.000000", maxLocationAvailable: "1.000000" }),
    ], 1);
    expect(verdict).toMatchObject({ orderable: true, availableQuantity: "1.000000" });
    expect(specialsAvailable([
      stock({ locationEvaluation: "PER_LOCATION", availableQuantity: "5.000000", maxLocationAvailable: "1.000000" }),
    ], 2).orderable).toBe(false);
  });

  it("adds demand that shares one inventory item before counting specials", () => {
    const verdict = specialsAvailable([
      stock({ catalogItemId: 1, quantity: "1", inventoryCatalogItemId: 8, availableQuantity: "3.000000" }),
      stock({ catalogItemId: 2, productName: "Beta", quantity: "1", inventoryCatalogItemId: 8, inventoryItemId: 18, availableQuantity: "3.000000" }),
    ], 1);
    expect(verdict).toMatchObject({ orderable: true, availableQuantity: "1.000000" });
    expect(specialsAvailable([
      stock({ catalogItemId: 1, quantity: "1", inventoryCatalogItemId: 8, availableQuantity: "3.000000" }),
      stock({ catalogItemId: 2, quantity: "1", inventoryCatalogItemId: 8, inventoryItemId: 18, availableQuantity: "3.000000" }),
    ], 2).orderable).toBe(false);
  });

  it("scales component consumption by the component quantity", () => {
    const verdict = specialsAvailable([
      stock({ quantity: "2", consumptionQuantity: "1.5", availableQuantity: "3.000000" }),
    ], 1);
    expect(verdict.orderable).toBe(true);
    expect(specialsAvailable([
      stock({ quantity: "2", consumptionQuantity: "1.5", availableQuantity: "2.900000" }),
    ], 1).orderable).toBe(false);
  });

  it("does not treat an inactive component as stock that can be sold", () => {
    expect(specialsAvailable([stock({ active: false })], 1).orderable).toBe(false);
    expect(checkoutComponentFromStock(stock({ active: false }))).toBeNull();
  });
});

describe("special reservation quantities", () => {
  it("reserves each component's physical quantity times the number of specials sold", () => {
    const component = checkoutComponentFromStock(stock({ quantity: "3", consumptionQuantity: "2", inventoryCatalogItemId: 4 }))!;
    expect(component.physicalQuantity).toBe("6.000000");
    expect(groupSpecialReservationDemands([component], 4)).toEqual([
      expect.objectContaining({ inventoryCatalogItemId: 4, physicalQuantity: "24.000000", locationEvaluation: "COMBINED_LOCATIONS" }),
    ]);
  });

  it("reserves a shared inventory item once for the combined component demand", () => {
    const first = checkoutComponentFromStock(stock({ catalogItemId: 1, quantity: "1", inventoryCatalogItemId: 8 }))!;
    const second = checkoutComponentFromStock(stock({ catalogItemId: 2, productName: "Beta", quantity: "2", inventoryCatalogItemId: 8, inventoryItemId: 18 }))!;
    const [demand] = groupSpecialReservationDemands([first, second], 2);
    expect(demand?.physicalQuantity).toBe("6.000000");
    expect(demand?.inventoryCatalogItemId).toBe(8);
  });

  it("keeps the sale price out of the reservation demand", () => {
    const demand = groupSpecialReservationDemands([checkoutComponentFromStock(stock())!], 1)[0]!;
    expect(demand).not.toHaveProperty("price");
    expect(demand).not.toHaveProperty("unitPrice");
  });
});

describe("special component snapshots", () => {
  const component: CheckoutComponent = {
    catalogItemId: 2,
    inventoryCatalogItemId: 20,
    inventoryItemId: 7,
    name: "Beta",
    quantity: "1.000000",
    physicalQuantity: "1.000000",
    locationEvaluation: "PER_LOCATION",
  };

  it("round-trips the component list stored on the order line", () => {
    const snapshot = { specialComponents: specialComponentSnapshot([component]) };
    expect(readSpecialComponentSnapshot(snapshot)).toEqual([component]);
    expect(displaySpecialComponents(snapshot)).toEqual([{ name: "Beta", quantity: "1" }]);
    expect(specialIncludesNote(displaySpecialComponents(snapshot))).toBe("Includes 1 Beta");
  });

  it("ignores ordinary lines and rejects a damaged special snapshot", () => {
    expect(readSpecialComponentSnapshot({ label: "Standard" })).toBeNull();
    expect(displaySpecialComponents({ specialComponents: [{ name: "Beta" }] })).toEqual([]);
    expect(() => readSpecialComponentSnapshot({ specialComponents: [{ name: "Beta" }] })).toThrow(/incomplete/i);
  });

  it("formats whole component quantities without trailing zeroes", () => {
    expect(formatRetailQuantity("2.000000")).toBe("2");
    expect(formatRetailQuantity("1.500000")).toBe("1.5");
  });
});

describe("special checkout wiring", () => {
  const orders = readFileSync(new URL("../../routes/orders.ts", import.meta.url), "utf8");
  const payments = readFileSync(new URL("../../payments/inventory.ts", import.meta.url), "utf8");

  it("charges the special line price and reserves component inventory", () => {
    expect(orders).toContain("unitPrice: String(line.unit_price.toFixed(2))");
    expect(orders).toContain("groupSpecialReservationDemands(special.components, line.quantity)");
    expect(orders).toContain("specialComponentSnapshot(special.components)");
    expect(orders).toContain("reserveCheckoutInventoryByOrderType(tx, houseTenantId, createdOrder.id,");
    expect(orders).toContain("inventoryCatalogItemId, physicalQuantity, orderType, orderItem.id,");
    expect(payments).toContain("readSpecialComponentSnapshot(item.variantSnapshot)");
    expect(payments).toContain("groupSpecialReservationDemands(specialComponents, item.quantity)");
  });
});
