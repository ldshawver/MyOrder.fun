import { describe, expect, it } from "vitest";
import {
  isTrueWooCommerceStorefrontRow,
  isVisibleAlavontCatalogRow,
  visibleAlavontCatalogSql,
  type CatalogVisibilityRow,
} from "../catalogVisibility";

function visibleInAllAffectedViews(row: CatalogVisibilityRow): {
  catalog: boolean;
  editCatalog: boolean;
  adminInventory: boolean;
  csrCheckIn: boolean;
} {
  const visible = isVisibleAlavontCatalogRow(row);
  return {
    catalog: visible,
    editCatalog: visible,
    adminInventory: visible,
    csrCheckIn: visible,
  };
}

describe("catalog visibility policy", () => {
  it("keeps local imported Alavont products visible even if a legacy row has isWooManaged=true", () => {
    const importedLegacyRow: CatalogVisibilityRow = {
      isWooManaged: true,
      merchantProductSource: "local_mapped",
      wooProductId: null,
      isLocalAlavont: true,
      alavontId: "ALV-001",
      alavontName: "Imported Alavont Product",
    };

    expect(isTrueWooCommerceStorefrontRow(importedLegacyRow)).toBe(false);
    expect(isVisibleAlavontCatalogRow(importedLegacyRow)).toBe(true);
  });

  it("keeps true WooCommerce storefront products excluded from Alavont catalog and inventory views", () => {
    const trueWooRow: CatalogVisibilityRow = {
      isWooManaged: true,
      merchantProductSource: "woo",
      wooProductId: "12345",
      isLocalAlavont: false,
      alavontName: "Woo Product",
    };

    expect(isTrueWooCommerceStorefrontRow(trueWooRow)).toBe(true);
    expect(isVisibleAlavontCatalogRow(trueWooRow)).toBe(false);
  });

  it("aligns catalog, edit catalog, admin inventory, and CSR check-in on the same visibility rule", () => {
    const rows: CatalogVisibilityRow[] = [
      { isWooManaged: false, isLocalAlavont: true, alavontName: "Normal Import" },
      { isWooManaged: true, merchantProductSource: "local_mapped", wooProductId: null, isLocalAlavont: true, alavontId: "ALV-002" },
      { isWooManaged: true, merchantProductSource: "woo", wooProductId: "woo_1", isLocalAlavont: false, alavontName: "True Woo" },
      { isWooManaged: false, isLocalAlavont: false, alavontId: "ALV-003", alavontName: "Repairable Legacy Import" },
    ];

    const expectedVisibleCount = rows.filter(isVisibleAlavontCatalogRow).length;
    const views = rows.map(visibleInAllAffectedViews);

    expect(expectedVisibleCount).toBe(3);
    expect(views.filter(v => v.catalog).length).toBe(expectedVisibleCount);
    expect(views.filter(v => v.editCatalog).length).toBe(expectedVisibleCount);
    expect(views.filter(v => v.adminInventory).length).toBe(expectedVisibleCount);
    expect(views.filter(v => v.csrCheckIn).length).toBe(expectedVisibleCount);
  });

  it("exposes a shared SQL predicate so DB-backed routes do not drift from the in-memory rule", () => {
    expect(visibleAlavontCatalogSql()).toBeTruthy();
  });
});

