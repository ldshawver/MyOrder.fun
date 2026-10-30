import { and, sql } from "drizzle-orm";
import { catalogItemsTable } from "@workspace/db";

/** Sale eligibility is independent of stock display preferences and menu source. */
export function publicCatalogEligibility() {
  return and(
    sql`coalesce(${catalogItemsTable.metadata}->>'archived', 'false') <> 'true'`,
    sql`coalesce(${catalogItemsTable.metadata}->>'complianceHold', 'false') <> 'true'`,
    sql`coalesce(${catalogItemsTable.metadata}->>'safeOnlyDuplicate', 'false') <> 'true'`,
    sql`${catalogItemsTable.metadata}->>'mergedIntoCatalogItemId' IS NULL`,
  );
}

export function isCatalogItemLifecycleEligible(row: { metadata?: unknown }): boolean {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown> : {};
  return metadata.archived !== true && metadata.archived !== "true"
    && metadata.complianceHold !== true && metadata.complianceHold !== "true"
    && metadata.safeOnlyDuplicate !== true && metadata.safeOnlyDuplicate !== "true"
    && metadata.mergedIntoCatalogItemId == null;
}

export function isCatalogItemForSale(row: { isAvailable: boolean; metadata?: unknown }): boolean {
  return row.isAvailable === true && isCatalogItemLifecycleEligible(row);
}
