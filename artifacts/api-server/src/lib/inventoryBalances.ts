/**
 * Shared helpers for inventory location setup and balance seeding.
 * Imported by both the inventory route and the catalog import route so that
 * the same idempotent logic runs after any operation that adds/changes
 * local Alavont products.
 */
import { eq, and, asc, sql, sum, inArray } from "drizzle-orm";
import {
  db,
  catalogItemsTable,
  inventoryBalancesTable,
  inventoryLocationsTable,
  csrBoxesTable,
} from "@workspace/db";
import { ensureInventoryBalanceClassificationSchema, sellableBalanceWhere } from "./inventoryHealth";
import { assertCatalogIdInventoryLookup } from "./inventoryIdentityGuard";
import { logger } from "./logger";

let inventoryTablesEnsured = false;
type InventoryDeductionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type InventoryDeductionExecutor = typeof db | InventoryDeductionTransaction;
const CHECKOUT_DEDUCTION_LOCATION_ORDER = ["Backstock", "Storefront", "CSR Sales Box 1", "CSR Sales Box 2"] as const;

function inventoryDebugWarningsEnabled(): boolean {
  return process.env.POS_INVENTORY_DEBUG === "true"
    || process.env.POS_INTEGRITY_DEBUG === "true"
    || (process.env.DEBUG ?? "").split(",").some(flag => flag.trim() === "pos:inventory" || flag.trim() === "pos:*");
}

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

const REQUIRED_BOOTSTRAP_LOCATION_NAMES = ["Backstock", "Storefront", "CSR Sales Box 1", "CSR Sales Box 2"] as const;

type InventoryBootstrapInsertRow = { id: number };
type InventoryBootstrapCountRow = { count: number | string };

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] }).rows ?? [];
}

export type InventoryBootstrapResult = {
  tenantId: number;
  rowsCreated: number;
  rowsAlreadyExisting: number;
  totalProductsProcessed: number;
  requiredLocations: string[];
};

export async function ensureAllInventoryRowsExistForTenant(tenantId: number): Promise<InventoryBootstrapResult> {
  await ensureStandardLocations(tenantId);

  const locationRows = await db
    .select({ id: inventoryLocationsTable.id, name: inventoryLocationsTable.name })
    .from(inventoryLocationsTable)
    .where(and(
      eq(inventoryLocationsTable.tenantId, tenantId),
      inArray(inventoryLocationsTable.name, [...REQUIRED_BOOTSTRAP_LOCATION_NAMES]),
    ));
  const missingLocationNames = REQUIRED_BOOTSTRAP_LOCATION_NAMES.filter(name => !locationRows.some(row => row.name === name));
  if (missingLocationNames.length > 0) throw new Error(`Missing bootstrap inventory locations: ${missingLocationNames.join(", ")}`);

  const productCount = Number(resultRows<InventoryBootstrapCountRow>(await db.execute(sql`
    SELECT count(*)::int AS count FROM catalog_items WHERE tenant_id = ${tenantId}
  `))[0]?.count ?? 0);

  const rowsAlreadyExisting = Number(resultRows<InventoryBootstrapCountRow>(await db.execute(sql`
    SELECT count(*)::int AS count
    FROM catalog_items ci
    JOIN inventory_locations il ON il.tenant_id = ci.tenant_id AND il.name = ANY(${[...REQUIRED_BOOTSTRAP_LOCATION_NAMES]})
    JOIN inventory_balances ib ON ib.tenant_id = ci.tenant_id AND ib.product_id = ci.id AND ib.location_id = il.id
    WHERE ci.tenant_id = ${tenantId}
  `))[0]?.count ?? 0);

  const insertedRows = resultRows<InventoryBootstrapInsertRow>(await db.execute(sql`
    INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity_on_hand, par_level, inventory_kind, is_sellable, updated_at)
    SELECT ${tenantId}, ci.id, il.id, 0, 0, 'sellable_catalog', true, now()
    FROM catalog_items ci
    JOIN inventory_locations il ON il.tenant_id = ci.tenant_id AND il.name = ANY(${[...REQUIRED_BOOTSTRAP_LOCATION_NAMES]})
    WHERE ci.tenant_id = ${tenantId}
      AND NOT EXISTS (
        SELECT 1 FROM inventory_balances ib
        WHERE ib.tenant_id = ci.tenant_id
          AND ib.product_id = ci.id
          AND ib.location_id = il.id
      )
    ON CONFLICT DO NOTHING
    RETURNING id
  `));

  return {
    tenantId,
    rowsCreated: insertedRows.length,
    rowsAlreadyExisting,
    totalProductsProcessed: productCount,
    requiredLocations: [...REQUIRED_BOOTSTRAP_LOCATION_NAMES],
  };
}

/**
 * Ensure every non-WooManaged catalog product has an inventory_balances row
 * for every active location. New rows are initialised with qty=0 (Backstock
 * uses the catalog_items.stock_quantity value as a seed if present).
 * Returns the number of rows created.
 */
export async function ensureAllInventoryBalances(_tenantId: number): Promise<{ created: number }> {
  throw new Error("inventory_balances mutation forbidden outside bootstrap-inventory, importer, and checkout deduction; use ensureAllInventoryRowsExistForTenant");
}

export interface CheckoutInventoryLocationDeduction {
  locationId: number;
  locationName: string | null;
  quantity: number;
}

export interface CheckoutInventoryDeductionResult {
  productId: number;
  requestedQuantity: number;
  availableBeforeDeduction: number;
  deductions: CheckoutInventoryLocationDeduction[];
}

/**
 * Checkout-only inventory deduction.
 *
 * Deduction drains deterministic locations in order: Backstock, Storefront,
 * CSR Sales Box 1, then CSR Sales Box 2. The helper records total available
 * inventory for diagnostics, but checkout success is determined by walking
 * this chain rather than treating a total as a primary stock source.
 */
export async function deductCheckoutInventoryBackstockFirst(
  executor: InventoryDeductionExecutor,
  tenantId: number,
  productId: number,
  quantity: number,
): Promise<CheckoutInventoryDeductionResult | null> {
  assertCatalogIdInventoryLookup(productId, "checkout.inventoryDeduction.backstockFirst");
  const requestedQuantity = Number(quantity);
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    throw new Error(`Invalid checkout inventory deduction quantity for catalogItemId ${productId}`);
  }

  const balances = await executor
    .select({
      id: inventoryBalancesTable.id,
      locationId: inventoryBalancesTable.locationId,
      locationName: inventoryLocationsTable.name,
      quantityOnHand: inventoryBalancesTable.quantityOnHand,
    })
    .from(inventoryBalancesTable)
    .innerJoin(inventoryLocationsTable, and(
      eq(inventoryLocationsTable.tenantId, inventoryBalancesTable.tenantId),
      eq(inventoryLocationsTable.id, inventoryBalancesTable.locationId),
    ))
    .where(and(
      sellableInventoryBalancePredicate(tenantId),
      eq(inventoryBalancesTable.productId, productId),
      sellableBalanceWhere(),
      eq(inventoryLocationsTable.isActive, true),
    ))
    .orderBy(
      sql`CASE ${inventoryLocationsTable.name}
        WHEN 'Backstock' THEN 0
        WHEN 'Storefront' THEN 1
        WHEN 'CSR Sales Box 1' THEN 2
        WHEN 'CSR Sales Box 2' THEN 3
        ELSE 4
      END`,
      asc(inventoryLocationsTable.displayOrder),
      asc(inventoryLocationsTable.id),
    );

  const availableBeforeDeduction = balances.reduce((sumQty, row) => sumQty + Number(row.quantityOnHand ?? 0), 0);
  if (inventoryDebugWarningsEnabled()) {
    const backstockQty = Number(balances.find(row => row.locationName === "Backstock")?.quantityOnHand ?? 0);
    const higherAllocated = balances
      .filter(row => row.locationName !== "Backstock" && Number(row.quantityOnHand ?? 0) > backstockQty)
      .map(row => ({ locationId: row.locationId, locationName: row.locationName, quantityOnHand: Number(row.quantityOnHand ?? 0) }));
    if (higherAllocated.length > 0) {
      logger.warn({
        tenantId,
        productId,
        backstockQty,
        higherAllocated,
        checkoutDeductionOrder: CHECKOUT_DEDUCTION_LOCATION_ORDER,
        stack: new Error("Allocated inventory exceeds Backstock primary stock").stack,
      }, "[POS_INVENTORY_DEBUG] allocated inventory exceeds Backstock primary stock");
    }
  }

  let remaining = requestedQuantity;
  const deductions: CheckoutInventoryLocationDeduction[] = [];
  for (const row of balances) {
    if (remaining <= 0) break;
    const availableAtLocation = Number(row.quantityOnHand ?? 0);
    if (availableAtLocation <= 0) continue;
    const deductionQuantity = Math.min(remaining, availableAtLocation);
    const updated = await executor
      .update(inventoryBalancesTable)
      .set({
        quantityOnHand: sql`${inventoryBalancesTable.quantityOnHand} - ${String(deductionQuantity)}`,
      })
      .where(and(
        eq(inventoryBalancesTable.id, row.id),
        sql`${inventoryBalancesTable.quantityOnHand} >= ${String(deductionQuantity)}`,
      ))
      .returning({ id: inventoryBalancesTable.id });
    if (updated.length !== 1) return null;
    deductions.push({
      locationId: row.locationId,
      locationName: row.locationName,
      quantity: deductionQuantity,
    });
    remaining -= deductionQuantity;
  }

  if (remaining > 0) return null;
  return {
    productId,
    requestedQuantity,
    availableBeforeDeduction,
    deductions,
  };
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
