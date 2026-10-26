import { and, eq, sql } from "drizzle-orm";
import { catalogItemsTable } from "@workspace/db";

/**
 * A catalogue row belongs in local physical inventory when it is explicitly
 * designated local, sellable, and not lifecycle-blocked. Woo linkage is
 * deliberately independent: Woo sync sets dropship rows isLocalAlavont=false,
 * while a reviewed Woo-listed exclusive may retain isLocalAlavont=true.
 */
export function locallyManagedSellableCatalogWhere(tenantId: number) {
  return and(
    eq(catalogItemsTable.tenantId, tenantId),
    eq(catalogItemsTable.isAvailable, true),
    eq(catalogItemsTable.isLocalAlavont, true),
    sql`coalesce(${catalogItemsTable.metadata}->>'archived', 'false') <> 'true'`,
    sql`coalesce(${catalogItemsTable.metadata}->>'complianceHold', 'false') <> 'true'`,
    sql`coalesce(${catalogItemsTable.metadata}->>'safeOnlyDuplicate', 'false') <> 'true'`,
    sql`${catalogItemsTable.metadata}->>'mergedIntoCatalogItemId' IS NULL`,
  );
}

export function isLocallyManagedSellableCatalogItem(row: {
  isAvailable: boolean;
  isLocalAlavont: boolean | null;
  metadata?: unknown;
}): boolean {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  return row.isAvailable === true
    && row.isLocalAlavont === true
    && metadata.archived !== true && metadata.archived !== "true"
    && metadata.complianceHold !== true && metadata.complianceHold !== "true"
    && metadata.safeOnlyDuplicate !== true && metadata.safeOnlyDuplicate !== "true"
    && metadata.mergedIntoCatalogItemId == null;
}
