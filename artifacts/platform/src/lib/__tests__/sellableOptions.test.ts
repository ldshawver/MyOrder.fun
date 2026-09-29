import { describe, expect, it } from "vitest";
import { checkoutOptionLines, optionCartEntry, selectedSellableOption, showOptionSelector, type SellableProduct } from "../sellableOptions";

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

  it("supports shared inventory options with different server prices", () => {
    const beans: SellableProduct = { id: 3, name: "Coffee Beans", options: [
      { id: 111, catalogItemId: 211, label: "250 g", price: "8.00", sku: null },
      { id: 112, catalogItemId: 212, label: "1 kg", price: "28.00", sku: null },
    ] };
    expect(optionCartEntry(beans, selectedSellableOption(beans, 112)!, null)).toMatchObject({ optionId: 112, price: 28 });
    expect(() => optionCartEntry(beans, shirt.options[0], null)).toThrow("Option does not belong to product");
  });
});
