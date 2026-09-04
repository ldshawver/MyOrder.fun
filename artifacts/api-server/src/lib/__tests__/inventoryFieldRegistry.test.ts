import { describe, expect, it } from "vitest";
import { inventoryFieldRegistry, importableInventoryFields } from "@workspace/db";

describe("canonical inventory field registry", () => {
  it("contains procurement fields and excludes legacy quantity authorities from imports", () => {
    expect(inventoryFieldRegistry.map((f) => f.key)).toEqual(expect.arrayContaining(["parLevel", "moq", "preferredReorderQuantity", "supplierName", "costBasis"]));
    expect(importableInventoryFields.map((f) => f.key)).not.toEqual(expect.arrayContaining(["stockQuantity", "currentStock"]));
  });

  it("marks balances as the only current quantity authority by policy", () => {
    expect(inventoryFieldRegistry.find((f) => f.key === "stockQuantity")).toMatchObject({ authority: "legacy", protected: true, editable: false });
    expect(inventoryFieldRegistry.find((f) => f.key === "currentStock")).toMatchObject({ authority: "legacy", protected: true, editable: false });
  });
});
