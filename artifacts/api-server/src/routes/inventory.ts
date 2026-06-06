import { Router, type IRouter } from "express";
import { eq, and, asc, sql } from "drizzle-orm";
import {
  db,
  catalogItemsTable,
  adminSettingsTable,
  inventoryBalancesTable,
  inventoryLocationsTable,
  csrBoxesTable,
} from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

let inventorySchemaEnsured = false;

async function ensureInventorySchema(): Promise<void> {
  if (inventorySchemaEnsured) return;
  const stmts = [
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "stock_quantity" numeric(10, 2) DEFAULT 0`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "stock_unit" text DEFAULT '#'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "par_level" numeric(10, 2) DEFAULT 0`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "regular_price" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_woo_managed" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_local_alavont" boolean NOT NULL DEFAULT true`,
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
  inventorySchemaEnsured = true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureStandardBoxes(tenantId: number): Promise<void> {
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

async function ensureStandardLocations(tenantId: number): Promise<void> {
  await ensureStandardBoxes(tenantId);
  const boxes = await db
    .select()
    .from(csrBoxesTable)
    .where(eq(csrBoxesTable.tenantId, tenantId));
  const box1 = boxes.find(b => b.slug === "sales-box-1");
  const box2 = boxes.find(b => b.slug === "sales-box-2");

  const seeds = [
    { type: "backstock",  name: "Backstock",        csrBoxId: null,             displayOrder: 1 },
    { type: "storefront", name: "Storefront",        csrBoxId: null,             displayOrder: 2 },
    { type: "csr_box",   name: "CSR Sales Box 1",   csrBoxId: box1?.id ?? null, displayOrder: 3 },
    { type: "csr_box",   name: "CSR Sales Box 2",   csrBoxId: box2?.id ?? null, displayOrder: 4 },
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

// Ensure every non-WooManaged catalog product has an inventory_balances row for
// every active location. Initialises new rows with qty=0 (backstock row uses the
// catalog_items.stock_quantity value if present as a seed).
async function ensureAllInventoryBalances(tenantId: number): Promise<{ created: number }> {
  await ensureStandardLocations(tenantId);
  const [products, locations] = await Promise.all([
    db
      .select({ id: catalogItemsTable.id, stockQuantity: catalogItemsTable.stockQuantity, parLevel: catalogItemsTable.parLevel })
      .from(catalogItemsTable)
      .where(and(
        eq(catalogItemsTable.tenantId, tenantId),
        sql`coalesce(${catalogItemsTable.isWooManaged}, false) = false`,
      )),
    db
      .select()
      .from(inventoryLocationsTable)
      .where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.isActive, true))),
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

router.use(async (_req, res, next) => {
  try {
    await ensureInventorySchema();
    next();
  } catch {
    res.status(500).json({ error: "Could not prepare inventory schema" });
  }
});

// ─── GET /api/admin/inventory ─────────────────────────────────────────────────
// Returns all non-WooManaged catalog products with per-location breakdown from
// inventory_balances, plus the list of active locations and petty cash total.
router.get(
  "/admin/inventory",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const houseTenantId = await getHouseTenantId();
    await ensureStandardLocations(houseTenantId);

    const [products, locations, balances, settingsRows] = await Promise.all([
      db
        .select({
          id: catalogItemsTable.id,
          name: catalogItemsTable.name,
          category: catalogItemsTable.category,
          price: catalogItemsTable.price,
          isAvailable: catalogItemsTable.isAvailable,
          alavontName: catalogItemsTable.alavontName,
          luciferCruzName: catalogItemsTable.luciferCruzName,
          alavontCategory: catalogItemsTable.alavontCategory,
          regularPrice: catalogItemsTable.regularPrice,
          stockQuantity: catalogItemsTable.stockQuantity,
          stockUnit: catalogItemsTable.stockUnit,
          parLevel: catalogItemsTable.parLevel,
          isWooManaged: catalogItemsTable.isWooManaged,
          isLocalAlavont: catalogItemsTable.isLocalAlavont,
        })
        .from(catalogItemsTable)
        .where(eq(catalogItemsTable.tenantId, houseTenantId))
        .orderBy(asc(catalogItemsTable.category), asc(catalogItemsTable.name)),
      db
        .select()
        .from(inventoryLocationsTable)
        .where(and(
          eq(inventoryLocationsTable.tenantId, houseTenantId),
          eq(inventoryLocationsTable.isActive, true),
        ))
        .orderBy(asc(inventoryLocationsTable.displayOrder)),
      db
        .select()
        .from(inventoryBalancesTable)
        .where(eq(inventoryBalancesTable.tenantId, houseTenantId)),
      db
        .select({ pettyCash: adminSettingsTable.pettyCash })
        .from(adminSettingsTable)
        .where(eq(adminSettingsTable.tenantId, houseTenantId))
        .limit(1),
    ]);

    // Only local Alavont products in the inventory grid
    const localItems = products.filter(p => p.isWooManaged !== true);

    // Build balance lookup: "productId:locationId" → balance row
    const balanceMap = new Map<string, typeof balances[0]>();
    for (const b of balances) {
      balanceMap.set(`${b.productId}:${b.locationId}`, b);
    }

    const locationMeta = locations.map(l => ({
      id: l.id,
      name: l.name,
      type: l.type,
      csrBoxId: l.csrBoxId,
      displayOrder: l.displayOrder,
    }));

    const enriched = localItems.map(item => {
      const locationBreakdown = locationMeta.map(loc => {
        const b = balanceMap.get(`${item.id}:${loc.id}`);
        return {
          locationId: loc.id,
          name: loc.name,
          type: loc.type,
          qty: b ? parseFloat(String(b.quantityOnHand)) : 0,
          par: b ? parseFloat(String(b.parLevel)) : 0,
        };
      });
      const totalStock = locationBreakdown.reduce((s, l) => s + l.qty, 0);
      return {
        id: item.id,
        name: item.name,
        alavontName: item.alavontName ?? null,
        luciferCruzName: item.luciferCruzName ?? null,
        category: item.alavontCategory ?? item.category,
        price: parseFloat(String(item.price)),
        regularPrice: item.regularPrice ? parseFloat(String(item.regularPrice)) : null,
        stockQuantity: totalStock,
        stockUnit: item.stockUnit ?? "#",
        parLevel: item.parLevel ? parseFloat(String(item.parLevel)) : 0,
        isAvailable: item.isAvailable,
        isWooManaged: item.isWooManaged ?? false,
        isLocalAlavont: item.isLocalAlavont ?? true,
        locations: locationBreakdown,
        totalStock,
      };
    });

    res.json({
      items: enriched,
      locations: locationMeta,
      pettyCash: settingsRows[0]?.pettyCash != null ? parseFloat(String(settingsRows[0].pettyCash)) : 0,
    });
  }
);

// ─── GET /api/admin/inventory/locations ──────────────────────────────────────
router.get(
  "/admin/inventory/locations",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    const houseTenantId = await getHouseTenantId();
    await ensureStandardLocations(houseTenantId);
    const locations = await db
      .select()
      .from(inventoryLocationsTable)
      .where(eq(inventoryLocationsTable.tenantId, houseTenantId))
      .orderBy(asc(inventoryLocationsTable.displayOrder));
    res.json({ locations });
  }
);

// ─── POST /api/admin/inventory/ensure-balances ────────────────────────────────
// Idempotent: creates missing inventory_balances rows for all products × all locations.
router.post(
  "/admin/inventory/ensure-balances",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    const houseTenantId = await getHouseTenantId();
    const { created } = await ensureAllInventoryBalances(houseTenantId);
    res.json({ ok: true, created });
  }
);

// ─── PATCH /api/admin/inventory/balance/:productId/:locationId ────────────────
// Upsert qty and/or par for a specific product × location combination.
router.patch(
  "/admin/inventory/balance/:productId/:locationId",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const productId = parseInt(String(req.params.productId), 10);
    const locationId = parseInt(String(req.params.locationId), 10);
    if (isNaN(productId) || isNaN(locationId)) {
      res.status(400).json({ error: "Invalid productId or locationId" });
      return;
    }

    const { qty, par } = req.body as { qty?: number; par?: number };
    const houseTenantId = await getHouseTenantId();

    const [existing] = await db
      .select({ id: inventoryBalancesTable.id })
      .from(inventoryBalancesTable)
      .where(and(
        eq(inventoryBalancesTable.tenantId, houseTenantId),
        eq(inventoryBalancesTable.productId, productId),
        eq(inventoryBalancesTable.locationId, locationId),
      ))
      .limit(1);

    if (existing) {
      const patch: Record<string, unknown> = {};
      if (qty !== undefined) patch.quantityOnHand = String(qty);
      if (par !== undefined) patch.parLevel = String(par);
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: "Nothing to update" });
        return;
      }
      await db.update(inventoryBalancesTable).set(patch).where(eq(inventoryBalancesTable.id, existing.id));
    } else {
      await db.insert(inventoryBalancesTable).values({
        tenantId: houseTenantId,
        productId,
        locationId,
        quantityOnHand: qty !== undefined ? String(qty) : "0",
        parLevel: par !== undefined ? String(par) : "0",
      });
    }

    const [updated] = await db
      .select()
      .from(inventoryBalancesTable)
      .where(and(
        eq(inventoryBalancesTable.tenantId, houseTenantId),
        eq(inventoryBalancesTable.productId, productId),
        eq(inventoryBalancesTable.locationId, locationId),
      ))
      .limit(1);

    res.json({
      productId,
      locationId,
      qty: updated ? parseFloat(String(updated.quantityOnHand)) : 0,
      par: updated ? parseFloat(String(updated.parLevel)) : 0,
    });
  }
);

// ─── PATCH /api/admin/inventory/:id ───────────────────────────────────────────
// Update catalog-level stock_quantity / stock_unit / par_level (backward compat).
// Also upserts the Backstock inventory_balance row to stay in sync.
router.patch(
  "/admin/inventory/:id",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const { stockQuantity, stockUnit, parLevel } = req.body as {
      stockQuantity?: number | null;
      stockUnit?: string;
      parLevel?: number | null;
    };

    const patch: Record<string, unknown> = {};
    if (stockQuantity !== undefined) patch.stockQuantity = stockQuantity != null ? String(stockQuantity) : null;
    if (stockUnit !== undefined) patch.stockUnit = stockUnit;
    if (parLevel !== undefined) patch.parLevel = parLevel != null ? String(parLevel) : "0";
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }

    const [updated] = await db
      .update(catalogItemsTable)
      .set(patch)
      .where(eq(catalogItemsTable.id, id))
      .returning({ id: catalogItemsTable.id, stockQuantity: catalogItemsTable.stockQuantity, stockUnit: catalogItemsTable.stockUnit, parLevel: catalogItemsTable.parLevel });

    if (!updated) { res.status(404).json({ error: "Item not found" }); return; }

    // Mirror stock_quantity to the Backstock inventory_balance row if it exists
    if (stockQuantity !== undefined && stockQuantity !== null) {
      try {
        const houseTenantId = await getHouseTenantId();
        const [backstockLoc] = await db
          .select({ id: inventoryLocationsTable.id })
          .from(inventoryLocationsTable)
          .where(and(
            eq(inventoryLocationsTable.tenantId, houseTenantId),
            eq(inventoryLocationsTable.type, "backstock"),
          ))
          .limit(1);
        if (backstockLoc) {
          await db
            .update(inventoryBalancesTable)
            .set({ quantityOnHand: String(stockQuantity) })
            .where(and(
              eq(inventoryBalancesTable.tenantId, houseTenantId),
              eq(inventoryBalancesTable.productId, id),
              eq(inventoryBalancesTable.locationId, backstockLoc.id),
            ));
        }
      } catch { /* non-critical */ }
    }

    res.json({
      id: updated.id,
      stockQuantity: updated.stockQuantity != null ? parseFloat(String(updated.stockQuantity)) : null,
      stockUnit: updated.stockUnit ?? "#",
      parLevel: updated.parLevel != null ? parseFloat(String(updated.parLevel)) : 0,
    });
  }
);

// ─── PATCH /api/admin/inventory/petty-cash ────────────────────────────────────
router.patch(
  "/admin/inventory/petty-cash",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const { pettyCash } = req.body as { pettyCash: number };
    if (typeof pettyCash !== "number" || isNaN(pettyCash)) {
      res.status(400).json({ error: "pettyCash must be a number" });
      return;
    }
    const houseTenantId = await getHouseTenantId();
    await db
      .update(adminSettingsTable)
      .set({ pettyCash: String(pettyCash.toFixed(2)) })
      .where(eq(adminSettingsTable.tenantId, houseTenantId));
    res.json({ pettyCash });
  }
);

export default router;
