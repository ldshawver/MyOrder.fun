import { describe, expect, it } from "vitest";
import { checkoutOptionLines, optionAxes, optionForValues, optionCartEntry, selectedSellableOption, showOptionSelector, type SellableProduct } from "../sellableOptions";

const shirt: SellableProduct = {
  id: 1, name: "T-Shirt", options: [
    { id: 101, catalogItemId: 201, label: "Small", price: "20.00", sku: "TS-S" },
    { id: 102, catalogItemId: 202, label: "Medium", price: "22.00", sku: "TS-M" },
    { id: 103, catalogItemId: 203, label: "Large", price: "24.00", sku: "TS-L" },
  ],
};

describe("sellable option selection", () => {
  it("keeps a backfilled single Standard option simple while sending its option ID", () => {
    const product = { id: 2, name: "Legacy Item", options: [{ id: 104, catalogItemId: 204, label: "Standard", price: "10.00", sku: null }] };
    expect(showOptionSelector(product)).toBe(false);
    const entry = optionCartEntry(product, selectedSellableOption(product, null)!, null);
    expect(entry).toMatchObject({ id: 204, optionId: 104, name: "Legacy Item", price: 10 });
    expect(checkoutOptionLines([{ ...entry, quantity: 2 }])).toEqual([{ optionId: 104, quantity: 2 }]);
  });

  it.each([[101, "Small", 20], [102, "Medium", 22], [103, "Large", 24]])("selects option %i through cart and checkout", (id, label, price) => {
    expect(showOptionSelector(shirt)).toBe(true);
    const option = selectedSellableOption(shirt, id)!;
    expect(option.label).toBe(label);
    const entry = optionCartEntry(shirt, option, null);
    expect(entry).toMatchObject({ optionId: id, name: `T-Shirt — ${label}`, price });
    expect(checkoutOptionLines([{ ...entry, quantity: 1 }])).toEqual([{ optionId: id, quantity: 1 }]);
  });

  it("requires an explicit valid option for a multi-option product", () => {
    expect(selectedSellableOption(shirt, null)).toBeUndefined();
    expect(selectedSellableOption(shirt, 999)).toBeUndefined();
    expect(showOptionSelector(shirt)).toBe(true);
  });

  it("supports shared inventory options with different server prices", () => {
    const beans: SellableProduct = { id: 3, name: "Coffee Beans", options: [
      { id: 111, catalogItemId: 211, label: "250 g", price: "8.00", sku: null },
      { id: 112, catalogItemId: 212, label: "1 kg", price: "28.00", sku: null },
    ] };
    expect(optionCartEntry(beans, selectedSellableOption(beans, 112)!, null)).toMatchObject({ optionId: 112, price: 28 });
    expect(() => optionCartEntry(beans, shirt.options[0], null)).toThrow("Option does not belong to product");
  });

  it("requires all Color and Size selections and preserves the selected variant identity/options in cart", () => {
    const product: SellableProduct = { id: 4, name: "Shirt", options: [
      { id: 401, catalogItemId: 501, label: "Red / Small", price: "18.00", sku: "RS", optionValues: { Color: "Red", Size: "S" } },
      { id: 402, catalogItemId: 502, label: "Red / Large", price: "19.00", sku: "RL", optionValues: { Color: "Red", Size: "L" } },
      { id: 403, catalogItemId: 503, label: "Blue / Small", price: "20.00", sku: "BS", optionValues: { Color: "Blue", Size: "S" } },
    ] };
    expect(optionAxes(product)).toEqual([{ name: "Color", values: ["Blue", "Red"] }, { name: "Size", values: ["L", "S"] }]);
    expect(optionForValues(product, { Color: "Red" })).toBeUndefined();
    expect(optionForValues(product, { Color: "Blue", Size: "L" })).toBeUndefined();
    const selected = optionForValues(product, { Color: "Red", Size: "L" })!;
    expect(selected).toMatchObject({ id: 402, sku: "RL", price: "19.00" });
    expect(optionCartEntry(product, selected, null)).toMatchObject({ id: 502, optionId: 402,
      optionValues: { Color: "Red", Size: "L" }, price: 19 });
    expect(checkoutOptionLines([{ ...optionCartEntry(product, selected, null), quantity: 1 }]))
      .toEqual([{ optionId: 402, quantity: 1 }]);
  });

  it.each(["Color", "Size"])("supports a single %s axis", axis => {
    const product: SellableProduct = { id: 9, name: "Variant product", options: [
      { id: 901, catalogItemId: 911, label: "A", price: "5.00", optionValues: { [axis]: "A" } },
      { id: 902, catalogItemId: 912, label: "B", price: "6.00", optionValues: { [axis]: "B" } },
    ] };
    expect(optionAxes(product)).toEqual([{ name: axis, values: ["A", "B"] }]);
    expect(optionForValues(product, { [axis]: "B" })?.id).toBe(902);
  });
});
