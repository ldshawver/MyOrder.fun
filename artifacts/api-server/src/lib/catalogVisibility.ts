import { sql, type SQL } from "drizzle-orm";
import { catalogItemsTable } from "@workspace/db";

export type CatalogVisibilityRow = {
  isWooManaged?: boolean | null;
  merchantProductSource?: string | null;
  wooProductId?: string | null;
  isLocalAlavont?: boolean | null;
  alavontId?: string | null;
  externalMenuId?: string | null;
  alavontName?: string | null;
  alavontCategory?: string | null;
  alavontImageUrl?: string | null;
};

export function isTrueWooCommerceStorefrontRow(row: CatalogVisibilityRow): boolean {
  return row.isWooManaged === true && row.merchantProductSource === "woo" && !!row.wooProductId;
}

export function isVisibleAlavontCatalogRow(row: CatalogVisibilityRow): boolean {
  if (isTrueWooCommerceStorefrontRow(row)) return false;
  if (row.isLocalAlavont !== false) return true;
  return !!(
    row.alavontId ||
    row.externalMenuId ||
    row.alavontName ||
    row.alavontCategory ||
    row.alavontImageUrl
  );
}

export function trueWooCommerceStorefrontSql(): SQL {
  return sql`COALESCE(${catalogItemsTable.isWooManaged}, false) = true AND ${catalogItemsTable.merchantProductSource} = 'woo' AND ${catalogItemsTable.wooProductId} IS NOT NULL`;
}

export function visibleAlavontCatalogSql(): SQL {
  return sql`NOT (${trueWooCommerceStorefrontSql()}) AND (COALESCE(${catalogItemsTable.isLocalAlavont}, true) = true OR ${catalogItemsTable.alavontId} IS NOT NULL OR ${catalogItemsTable.externalMenuId} IS NOT NULL OR ${catalogItemsTable.alavontName} IS NOT NULL OR ${catalogItemsTable.alavontCategory} IS NOT NULL OR ${catalogItemsTable.alavontImageUrl} IS NOT NULL)`;
}

