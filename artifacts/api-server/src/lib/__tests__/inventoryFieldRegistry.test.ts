import { describe, expect, it } from "vitest";
import { inventoryFieldRegistry, importableInventoryFields, importableCatalogueFields, exportableCatalogueFields, merchantEditableCatalogueFields } from "@workspace/db";
import { CATALOG_IMPORT_HEADERS } from "../../routes/import";

describe("canonical inventory field registry", () => {
  it("contains procurement fields and excludes legacy quantity authorities from imports", () => {
    expect(inventoryFieldRegistry.map((f) => f.key)).toEqual(expect.arrayContaining(["parLevel", "moq", "preferredReorderQuantity", "supplierName", "costBasis"]));
    expect(importableInventoryFields.map((f) => f.key)).not.toEqual(expect.arrayContaining(["stockQuantity", "currentStock"]));
  });

  it("marks balances as the only current quantity authority by policy", () => {
    expect(inventoryFieldRegistry.find((f) => f.key === "stockQuantity")).toMatchObject({ authority: "legacy", protected: true, editable: false });
    expect(inventoryFieldRegistry.find((f) => f.key === "currentStock")).toMatchObject({ authority: "legacy", protected: true, editable: false });
  });

  it("keeps every merchant import/export field in the registry-driven import lifecycle", () => {
    const importable = importableCatalogueFields.filter(field => field.classification === "merchant_editable");
    const exportable = exportableCatalogueFields.filter(field => field.classification === "merchant_editable");
    expect(importable.map(field => field.header)).toEqual(expect.arrayContaining(merchantEditableCatalogueFields.filter(field => field.importable).map(field => field.header)));
    expect(exportable.map(field => field.header)).toEqual(expect.arrayContaining(merchantEditableCatalogueFields.filter(field => field.exportable).map(field => field.header)));
    expect(CATALOG_IMPORT_HEADERS).toEqual(expect.arrayContaining(importableCatalogueFields.map(field => field.header)));
    expect(new Set(importableCatalogueFields.map(field => field.header)).size).toBe(importableCatalogueFields.length);
  });

  it("maps the legacy homie price storage key to the Employee Discount business field", () => {
    expect(inventoryFieldRegistry.find(field => field.key === "homiePrice")).toMatchObject({
      label: "Employee Discount", header: "Employee Discount", dbField: "homiePrice", aliases: expect.arrayContaining(["homie_price"]),
    });
    for (const key of ["supplierName", "vendorSku", "costBasis"]) {
      expect(inventoryFieldRegistry.find(field => field.key === key)).toMatchObject({ classification: "internal", editable: false, importable: false, exportable: false });
    }
  });
});
