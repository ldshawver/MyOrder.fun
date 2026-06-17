/**
 * Shared helpers for inventory location setup and balance seeding.
 * Imported by both the inventory route and the catalog import route so that
 * the same idempotent logic runs after any operation that adds/changes
 * local Alavont products.
 */
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  catalogItemsTable,
  inventoryBalancesTable,
  inventoryLocationsTable,
  csrBoxesTable,
} from "@workspace/db";
import { visibleAlavontCatalogSql } from "./catalogVisibility";

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
    sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_balances_unique') THEN
        ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_unique"
          UNIQUE ("tenant_id", "product_id", "location_id");
      END IF;
    END $$`,
  ];
  for (const stmt of stmts) await db.execute(stmt);
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
        visibleAlavontCatalogSql(),
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
