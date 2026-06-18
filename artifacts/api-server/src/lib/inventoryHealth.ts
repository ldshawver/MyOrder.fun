import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  catalogItemsTable,
  inventoryBalancesTable,
  inventoryLocationsTable,
} from "@workspace/db";

export const INVENTORY_KIND_SELLABLE = "sellable";
export const INVENTORY_KIND_NON_SELLABLE_SUPPLY = "non_sellable_supply";

export const INVENTORY_HEALTH_CLASSIFICATIONS = [
  "sellable_catalog_product",
  "non_sellable_supply",
  "orphan_balance",
  "invalid_location",
  "invalid_product",
] as const;
export type InventoryHealthClassification = typeof INVENTORY_HEALTH_CLASSIFICATIONS[number];

export async function ensureInventoryBalanceClassificationSchema(): Promise<void> {
  const statements = [
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "inventory_kind" text NOT NULL DEFAULT 'sellable'`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "is_sellable" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "quarantined_at" timestamptz`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "quarantined_by_user_id" integer`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "quarantine_reason" text`,
  ];
  for (const statement of statements) await db.execute(statement);
}

export function sellableBalanceWhere() {
  return and(
    eq(inventoryBalancesTable.isSellable, true),
    eq(inventoryBalancesTable.inventoryKind, INVENTORY_KIND_SELLABLE),
    sql`${inventoryBalancesTable.quarantinedAt} IS NULL`,
  );
}

type BalanceRow = typeof inventoryBalancesTable.$inferSelect;
type ProductRow = typeof catalogItemsTable.$inferSelect;
type LocationRow = typeof inventoryLocationsTable.$inferSelect;

export type InventoryHealthRow = {
  id: number;
  tenantId: number;
  productId: number;
  locationId: number;
  quantityOnHand: number;
  parLevel: number;
  updatedAt: Date | null;
  classification: InventoryHealthClassification;
  inventoryKind: string;
  isSellable: boolean;
  quarantinedAt: Date | null;
  quarantinedByUserId: number | null;
  quarantineReason: string | null;
  productName: string | null;
  locationName: string | null;
  locationIsActive: boolean | null;
};

export function classifyInventoryBalance(params: {
  balance: Pick<BalanceRow, "inventoryKind" | "isSellable">;
  product?: Pick<ProductRow, "id" | "isAvailable"> | null;
  location?: Pick<LocationRow, "id" | "isActive"> | null;
}): InventoryHealthClassification {
  const { balance, product, location } = params;
  if (!product && !location) return "orphan_balance";
  if (!product) return "invalid_product";
  if (!location || location.isActive === false) return "invalid_location";
  if (balance.inventoryKind === INVENTORY_KIND_NON_SELLABLE_SUPPLY || balance.isSellable === false) return "non_sellable_supply";
  return "sellable_catalog_product";
}

export async function getInventoryHealthReport(tenantId: number): Promise<{ rows: InventoryHealthRow[]; summary: Record<InventoryHealthClassification, number> }> {
  await ensureInventoryBalanceClassificationSchema();
  const balances = await db.select().from(inventoryBalancesTable).where(eq(inventoryBalancesTable.tenantId, tenantId));
  const productIds = [...new Set(balances.map(b => b.productId))];
  const locationIds = [...new Set(balances.map(b => b.locationId))];
  const [products, locations] = await Promise.all([
    productIds.length ? db.select().from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), inArray(catalogItemsTable.id, productIds))) : Promise.resolve([]),
    locationIds.length ? db.select().from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, tenantId), inArray(inventoryLocationsTable.id, locationIds))) : Promise.resolve([]),
  ]);
  const productById = new Map(products.map(p => [p.id, p]));
  const locationById = new Map(locations.map(l => [l.id, l]));
  const summary = Object.fromEntries(INVENTORY_HEALTH_CLASSIFICATIONS.map(c => [c, 0])) as Record<InventoryHealthClassification, number>;
  const rows = balances.map((balance): InventoryHealthRow => {
    const product = productById.get(balance.productId) ?? null;
    const location = locationById.get(balance.locationId) ?? null;
    const classification = classifyInventoryBalance({ balance, product, location });
    summary[classification] += 1;
    return {
      id: balance.id,
      tenantId: balance.tenantId,
      productId: balance.productId,
      locationId: balance.locationId,
      quantityOnHand: Number(balance.quantityOnHand ?? 0),
      parLevel: Number(balance.parLevel ?? 0),
      updatedAt: balance.updatedAt ?? null,
      classification,
      inventoryKind: balance.inventoryKind ?? INVENTORY_KIND_SELLABLE,
      isSellable: balance.isSellable !== false,
      quarantinedAt: balance.quarantinedAt ?? null,
      quarantinedByUserId: balance.quarantinedByUserId ?? null,
      quarantineReason: balance.quarantineReason ?? null,
      productName: product?.alavontName ?? product?.name ?? null,
      locationName: location?.name ?? null,
      locationIsActive: location?.isActive ?? null,
    };
  });
  return { rows, summary };
}
