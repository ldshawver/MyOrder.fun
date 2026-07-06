/**
 * Shared helpers for inventory location setup and balance seeding.
 * Imported by both the inventory route and the catalog import route so that
 * the same idempotent logic runs after any operation that adds/changes
 * local Alavont products.
 */
import { eq, and, asc, sql, sum } from "drizzle-orm";
import {
  db,
  catalogItemsTable,
  inventoryBalancesTable,
  inventoryLocationsTable,
  csrBoxesTable,
} from "@workspace/db";
import { ensureInventoryBalanceClassificationSchema } from "./inventoryHealth";
import { assertCatalogIdInventoryLookup } from "./inventoryIdentityGuard";

let inventoryTablesEnsured = false;

async function ensureInventoryTablesExist(): Promise<void> {
  if (inventoryTablesEnsured) return;
  const stmts = [
    sql`CREATE TABLE IF NOT EXISTS "csr_boxes" (
      "id" serial PRIMARY KEY,
      "tenant_id" integer NOT NULL,
      "slug" text NOT NULL,
      "label" text NOT NULL,
      "description" text,
      "location" text,
      "is_active" boolean NOT NULL DEFAULT true,
      "display_order" integer NOT NULL DEFAULT 0,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`,
    sql`CREATE TABLE IF NOT EXISTS "inventory_locations" (
      "id" serial PRIMARY KEY,
      "tenant_id" integer NOT NULL,
      "type" text NOT NULL,
      "csr_box_id" integer,
      "name" text NOT NULL,
      "is_active" boolean NOT NULL DEFAULT true,
      "display_order" integer NOT NULL DEFAULT 0,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`,
    sql`CREATE TABLE IF NOT EXISTS "inventory_balances" (
      "id" serial PRIMARY KEY,
      "tenant_id" integer NOT NULL,
      "product_id" integer NOT NULL,
      "location_id" integer NOT NULL,
      "quantity_on_hand" numeric(10, 3) NOT NULL DEFAULT 0,
      "par_level" numeric(10, 2) NOT NULL DEFAULT 0,
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "inventory_kind" text NOT NULL DEFAULT 'sellable_catalog'`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "is_sellable" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "quarantined_at" timestamptz`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "quarantined_by_user_id" integer`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "quarantine_reason" text`,
    sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_balances_unique') THEN
        ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_unique"
          UNIQUE ("tenant_id", "product_id", "location_id");
      END IF;
    END $$`,
  ];
  for (const stmt of stmts) await db.execute(stmt);
  await ensureInventoryBalanceClassificationSchema();
  inventoryTablesEnsured = true;
}

export async function ensureStandardBoxes(tenantId: number): Promise<void> {
  await ensureInventoryTablesExist();
  const [first] = await db
    .select({ id: csrBoxesTable.id })
    .from(csrBoxesTable)
    .where(eq(csrBoxesTable.tenantId, tenantId))
    .limit(1);
  if (!first) {
    await db.insert(csrBoxesTable).values([
      { tenantId, slug: "sales-box-1", label: "CSR Sales Box 1", displayOrder: 1, isActive: true },
      { tenantId, slug: "sales-box-2", label: "CSR Sales Box 2", displayOrder: 2, isActive: true },
    ]);
  }
}

export async function ensureStandardLocations(tenantId: number): Promise<void> {
  await ensureStandardBoxes(tenantId);
  const boxes = await db
    .select()
    .from(csrBoxesTable)
    .where(eq(csrBoxesTable.tenantId, tenantId));
  const box1 = boxes.find(b => b.slug === "sales-box-1");
  const box2 = boxes.find(b => b.slug === "sales-box-2");

  const seeds = [
    { type: "backstock",  name: "Backstock",      csrBoxId: null,             displayOrder: 1 },
    { type: "storefront", name: "Storefront",      csrBoxId: null,             displayOrder: 2 },
    { type: "csr_box",   name: "CSR Sales Box 1", csrBoxId: box1?.id ?? null, displayOrder: 3 },
    { type: "csr_box",   name: "CSR Sales Box 2", csrBoxId: box2?.id ?? null, displayOrder: 4 },
  ];
  for (const seed of seeds) {
    const [ex] = await db
      .select({ id: inventoryLocationsTable.id })
      .from(inventoryLocationsTable)
      .where(and(
        eq(inventoryLocationsTable.tenantId, tenantId),
        eq(inventoryLocationsTable.name, seed.name),
      ))
      .limit(1);
    if (!ex) {
      await db.insert(inventoryLocationsTable).values({
        tenantId,
        type: seed.type,
        csrBoxId: seed.csrBoxId,
        name: seed.name,
        isActive: true,
        displayOrder: seed.displayOrder,
      });
    }
  }
}

/**
 * Ensure every non-WooManaged catalog product has an inventory_balances row
 * for every active location. New rows are initialised with qty=0 (Backstock
 * uses the catalog_items.stock_quantity value as a seed if present).
 * Returns the number of rows created.
 */
export async function ensureAllInventoryBalances(tenantId: number): Promise<{ created: number }> {
  await ensureStandardLocations(tenantId);

  const [products, locations] = await Promise.all([
    db
      .select({
        id: catalogItemsTable.id,
        stockQuantity: catalogItemsTable.stockQuantity,
        parLevel: catalogItemsTable.parLevel,
      })
      .from(catalogItemsTable)
      .where(and(
        eq(catalogItemsTable.tenantId, tenantId),
        sql`coalesce(${catalogItemsTable.isWooManaged}, false) = false`,
        eq(catalogItemsTable.isAvailable, true),
      )),
    db
      .select()
      .from(inventoryLocationsTable)
      .where(and(
        eq(inventoryLocationsTable.tenantId, tenantId),
        eq(inventoryLocationsTable.isActive, true),
      )),
  ]);

  const backstockLoc = locations.find(l => l.type === "backstock");
  let created = 0;

  for (const prod of products) {
    assertCatalogIdInventoryLookup(prod.id, "ensureAllInventoryBalances");
    for (const loc of locations) {
      const [exists] = await db
        .select({ id: inventoryBalancesTable.id })
        .from(inventoryBalancesTable)
        .where(and(
          eq(inventoryBalancesTable.tenantId, tenantId),
          eq(inventoryBalancesTable.productId, prod.id),
          eq(inventoryBalancesTable.locationId, loc.id),
        ))
        .limit(1);
      if (!exists) {
        const initQty = loc.id === backstockLoc?.id
          ? String(prod.stockQuantity ?? "0")
          : "0";
        await db.insert(inventoryBalancesTable).values({
          tenantId,
          productId: prod.id,
          locationId: loc.id,
          quantityOnHand: initQty,
          parLevel: String(prod.parLevel ?? "0"),
        });
        created++;
      }
    }
  }
  return { created };
}


export interface CatalogInventoryLocationSnapshot {
  locationId: number;
  name: string;
  type: string;
  csrBoxId: number | null;
  displayOrder: number | null;
  qty: number;
  par: number;
}

export interface CatalogInventorySnapshotItem {
  id: number;
  name: string;
  alavontName: string | null;
  luciferCruzName: string | null;
  customerSafeName: string | null;
  category: string | null;
  price: number;
  regularPrice: number | null;
  stockQuantity: number;
  stockUnit: string;
  parLevel: number;
  isAvailable: boolean | null;
  isWooManaged: boolean;
  isLocalAlavont: boolean;
  isSellable: boolean;
  inventoryKind: "sellable_catalog";
  locations: CatalogInventoryLocationSnapshot[];
  totalStock: number;
}


export function sellableInventoryBalancePredicate(tenantId: number) {
  return and(
    eq(inventoryBalancesTable.tenantId, tenantId),
    eq(inventoryBalancesTable.isSellable, true),
    eq(inventoryBalancesTable.inventoryKind, "sellable_catalog"),
    sql`${inventoryBalancesTable.quarantinedAt} IS NULL`,
    sql`EXISTS (
      SELECT 1 FROM catalog_items ci
      WHERE ci.id = ${inventoryBalancesTable.productId}
        AND ci.tenant_id = ${tenantId}
    )`,
    sql`EXISTS (
      SELECT 1 FROM inventory_locations il
      WHERE il.id = ${inventoryBalancesTable.locationId}
        AND il.tenant_id = ${tenantId}
        AND il.is_active = true
    )`,
  );
}

export async function recomputeCatalogInventoryTotals(tenantId: number, productId: number): Promise<void> {
  assertCatalogIdInventoryLookup(productId, "recomputeCatalogInventoryTotals");
  const [totals] = await db
    .select({ qty: sum(inventoryBalancesTable.quantityOnHand), par: sum(inventoryBalancesTable.parLevel) })
    .from(inventoryBalancesTable)
    .where(and(
      sellableInventoryBalancePredicate(tenantId),
      eq(inventoryBalancesTable.productId, productId),
    ));

  await db
    .update(catalogItemsTable)
    .set({
      stockQuantity: String(totals?.qty ?? "0"),
      inventoryAmount: String(totals?.qty ?? "0"),
      parLevel: String(totals?.par ?? "0"),
    })
    .where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, productId)));
}

export async function getCatalogInventorySnapshot(tenantId: number): Promise<{
  items: CatalogInventorySnapshotItem[];
  locations: Array<{ id: number; name: string; type: string; csrBoxId: number | null; displayOrder: number | null }>;
}> {
  // Inventory/PAR must show only real catalog identities that already have
  // inventory rows. Safe presentation fields must never synthesize products.
  await ensureStandardLocations(tenantId);
  const [products, locations, balances] = await Promise.all([
    db.select({
      id: catalogItemsTable.id,
      name: catalogItemsTable.name,
      category: catalogItemsTable.category,
      price: catalogItemsTable.price,
      isAvailable: catalogItemsTable.isAvailable,
      alavontName: catalogItemsTable.alavontName,
      luciferCruzName: catalogItemsTable.luciferCruzName,
      customerSafeName: catalogItemsTable.customerSafeName,
      alavontCategory: catalogItemsTable.alavontCategory,
      regularPrice: catalogItemsTable.regularPrice,
      stockUnit: catalogItemsTable.stockUnit,
      isWooManaged: catalogItemsTable.isWooManaged,
      isLocalAlavont: catalogItemsTable.isLocalAlavont,
    }).from(catalogItemsTable)
      .where(and(
        eq(catalogItemsTable.tenantId, tenantId),
        sql`coalesce(${catalogItemsTable.isWooManaged}, false) = false`,
        sql`coalesce(${catalogItemsTable.isLocalAlavont}, true) = true`,
        eq(catalogItemsTable.isAvailable, true),
        sql`coalesce((${catalogItemsTable.metadata}->>'archived')::boolean, false) = false`,
        sql`coalesce((${catalogItemsTable.metadata}->>'safeOnlyDuplicate')::boolean, false) = false`,
        sql`EXISTS (
          SELECT 1 FROM inventory_balances ib
          WHERE ib.tenant_id = ${tenantId}
            AND ib.product_id = ${catalogItemsTable.id}
        )`
      ))
      .orderBy(asc(catalogItemsTable.id)),
    db.select().from(inventoryLocationsTable)
      .where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.isActive, true)))
      .orderBy(asc(inventoryLocationsTable.displayOrder)),
    db.select().from(inventoryBalancesTable).where(sellableInventoryBalancePredicate(tenantId)),
  ]);

  const productIds = new Set(products.map(p => p.id));
  const locationIds = new Set(locations.map(l => l.id));
  const balanceMap = new Map<string, typeof balances[0]>();
  for (const b of balances) {
    if (!productIds.has(b.productId) || !locationIds.has(b.locationId)) continue;
    balanceMap.set(`${b.productId}:${b.locationId}`, b);
  }

  const locationMeta = locations.map(l => ({ id: l.id, name: l.name, type: l.type, csrBoxId: l.csrBoxId, displayOrder: l.displayOrder }));
  const items = products.map((item): CatalogInventorySnapshotItem => {
    const locationBreakdown = locationMeta.map(loc => {
      const b = balanceMap.get(`${item.id}:${loc.id}`);
      return {
        locationId: loc.id,
        name: loc.name,
        type: loc.type,
        csrBoxId: loc.csrBoxId,
        displayOrder: loc.displayOrder,
        qty: b ? parseFloat(String(b.quantityOnHand)) : 0,
        par: b ? parseFloat(String(b.parLevel)) : 0,
      };
    });
    const totalStock = locationBreakdown.reduce((total, loc) => total + loc.qty, 0);
    const parLevel = locationBreakdown.reduce((total, loc) => total + loc.par, 0);
    return {
      id: item.id,
      name: item.name,
      alavontName: item.alavontName ?? null,
      luciferCruzName: item.luciferCruzName ?? null,
      customerSafeName: item.customerSafeName ?? item.luciferCruzName ?? null,
      category: item.alavontCategory ?? item.category,
      price: parseFloat(String(item.price)),
      regularPrice: item.regularPrice ? parseFloat(String(item.regularPrice)) : null,
      stockQuantity: totalStock,
      stockUnit: item.stockUnit ?? "#",
      parLevel,
      isAvailable: item.isAvailable,
      isWooManaged: item.isWooManaged ?? false,
      isLocalAlavont: item.isLocalAlavont ?? true,
      isSellable: item.isAvailable !== false,
      inventoryKind: "sellable_catalog",
      locations: locationBreakdown,
      totalStock,
    };
  });
  return { items, locations: locationMeta };
}


export type OrphanInventoryBalanceReason = "missing_catalog_product" | "missing_location" | "non_sellable_supply" | "quarantined";

export interface OrphanInventoryBalanceReportItem {
  id: number;
  tenantId: number;
  productId: number;
  locationId: number;
  quantityOnHand: number;
  parLevel: number;
  inventoryKind: "sellable_catalog" | "non_sellable_supply";
  quarantinedAt: Date | null;
  quarantinedByUserId: number | null;
  quarantineReason: string | null;
  productName: string | null;
  locationName: string | null;
  reason: OrphanInventoryBalanceReason;
}

export async function getOrphanInventoryBalanceReport(tenantId: number): Promise<OrphanInventoryBalanceReportItem[]> {
  await ensureInventoryTablesExist();
  const rows = await db
    .select({
      id: inventoryBalancesTable.id,
      tenantId: inventoryBalancesTable.tenantId,
      productId: inventoryBalancesTable.productId,
      locationId: inventoryBalancesTable.locationId,
      quantityOnHand: inventoryBalancesTable.quantityOnHand,
      parLevel: inventoryBalancesTable.parLevel,
      inventoryKind: inventoryBalancesTable.inventoryKind,
      isSellable: inventoryBalancesTable.isSellable,
      quarantinedAt: inventoryBalancesTable.quarantinedAt,
      quarantinedByUserId: inventoryBalancesTable.quarantinedByUserId,
      quarantineReason: inventoryBalancesTable.quarantineReason,
      productName: catalogItemsTable.name,
      productTenantId: catalogItemsTable.tenantId,
      locationName: inventoryLocationsTable.name,
      locationTenantId: inventoryLocationsTable.tenantId,
    })
    .from(inventoryBalancesTable)
    .leftJoin(catalogItemsTable, eq(inventoryBalancesTable.productId, catalogItemsTable.id))
    .leftJoin(inventoryLocationsTable, eq(inventoryBalancesTable.locationId, inventoryLocationsTable.id))
    .where(and(
      eq(inventoryBalancesTable.tenantId, tenantId),
      sql`(
        ${catalogItemsTable.id} IS NULL
        OR ${catalogItemsTable.tenantId} <> ${tenantId}
        OR ${inventoryLocationsTable.id} IS NULL
        OR ${inventoryLocationsTable.tenantId} <> ${tenantId}
        OR ${inventoryBalancesTable.inventoryKind} <> 'sellable_catalog'
        OR ${inventoryBalancesTable.isSellable} <> true
        OR ${inventoryBalancesTable.quarantinedAt} IS NOT NULL
      )`,
    ))
    .orderBy(asc(inventoryBalancesTable.id));

  return rows.map((row): OrphanInventoryBalanceReportItem => {
    let reason: OrphanInventoryBalanceReason = "missing_catalog_product";
    if (row.inventoryKind === "non_sellable_supply") reason = "non_sellable_supply";
    else if (row.quarantinedAt != null) reason = "quarantined";
    else if (!row.locationTenantId) reason = "missing_location";
    return {
      id: row.id,
      tenantId: row.tenantId,
      productId: row.productId,
      locationId: row.locationId,
      quantityOnHand: parseFloat(String(row.quantityOnHand ?? "0")),
      parLevel: parseFloat(String(row.parLevel ?? "0")),
      inventoryKind: row.inventoryKind === "non_sellable_supply" ? "non_sellable_supply" : "sellable_catalog",
      quarantinedAt: row.quarantinedAt ?? null,
      quarantinedByUserId: row.quarantinedByUserId ?? null,
      quarantineReason: row.quarantineReason ?? null,
      productName: row.productName ?? null,
      locationName: row.locationName ?? null,
      reason,
    };
  });
}
