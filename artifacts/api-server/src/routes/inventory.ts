import { Router, type IRouter } from "express";
import { eq, and, asc, sql, sum } from "drizzle-orm";
import {
  db,
  catalogItemsTable,
  adminSettingsTable,
  inventoryBalancesTable,
  inventoryLocationsTable,
} from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved, writeAuditLog, normalizeRole } from "../lib/auth";
import { z } from "zod";
import { getHouseTenantId } from "../lib/singleTenant";
import {
  ensureStandardLocations,
  ensureAllInventoryBalances,
} from "../lib/inventoryBalances";
import {
  ensureInventoryBalanceClassificationSchema,
  getInventoryHealthReport,
  sellableBalanceWhere,
  INVENTORY_KIND_NON_SELLABLE_SUPPLY,
  INVENTORY_KIND_SELLABLE,
} from "../lib/inventoryHealth";

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
  await ensureInventoryBalanceClassificationSchema();
  inventorySchemaEnsured = true;
}


async function recomputeCatalogInventoryTotals(tenantId: number, productId: number): Promise<void> {
  const [totals] = await db
    .select({ qty: sum(inventoryBalancesTable.quantityOnHand), par: sum(inventoryBalancesTable.parLevel) })
    .from(inventoryBalancesTable)
    .where(and(
      eq(inventoryBalancesTable.tenantId, tenantId),
      eq(inventoryBalancesTable.productId, productId),
      sellableBalanceWhere(),
    ));

  await db
    .update(catalogItemsTable)
    .set({
      stockQuantity: String(totals?.qty ?? "0"),
      inventoryAmount: String(totals?.qty ?? "0"),
      parLevel: String(totals?.par ?? "0"),
    })
    .where(and(
      eq(catalogItemsTable.tenantId, tenantId),
      eq(catalogItemsTable.id, productId),
    ));
}


async function resolveInventoryTenantId(req: import("express").Request): Promise<number> {
  const actor = req.dbUser!;
  const role = normalizeRole(actor.role);
  if (role === "global_admin") {
    const requested = req.query.tenantId ? Number(req.query.tenantId) : undefined;
    if (requested && Number.isInteger(requested) && requested > 0) return requested;
  }
  return actor.tenantId ?? await getHouseTenantId();
}

const balanceIdParams = z.object({ id: z.coerce.number().int().positive() }).strict();
const quarantineBody = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();
const classifyBody = z.object({ inventoryKind: z.enum([INVENTORY_KIND_SELLABLE, INVENTORY_KIND_NON_SELLABLE_SUPPLY]) }).strict();

router.use(async (_req, res, next) => {
  try {
    await ensureInventorySchema();
    next();
  } catch {
    res.status(500).json({ error: "Could not prepare inventory schema" });
  }
});

// ─── GET /api/admin/inventory/health ─────────────────────────────────────────
router.get(
  "/admin/inventory/health",
  requireRole("global_admin", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const tenantId = await resolveInventoryTenantId(req);
    const report = await getInventoryHealthReport(tenantId);
    res.json({ tenantId, ...report });
  }
);

// ─── POST /api/admin/inventory/balances/:id/quarantine ───────────────────────
router.post(
  "/admin/inventory/balances/:id/quarantine",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const params = balanceIdParams.safeParse(req.params);
    const body = quarantineBody.safeParse(req.body);
    if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
    if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
    const tenantId = await resolveInventoryTenantId(req);
    const [current] = await db.select().from(inventoryBalancesTable)
      .where(and(eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.id, params.data.id)))
      .limit(1);
    if (!current) { res.status(404).json({ error: "Balance not found for this tenant" }); return; }

    const [updated] = await db.update(inventoryBalancesTable).set({
      isSellable: false,
      inventoryKind: current.inventoryKind === INVENTORY_KIND_NON_SELLABLE_SUPPLY ? INVENTORY_KIND_NON_SELLABLE_SUPPLY : INVENTORY_KIND_SELLABLE,
      quarantinedAt: new Date(),
      quarantinedByUserId: actor.id,
      quarantineReason: body.data.reason ?? "Quarantined from inventory health report",
    }).where(and(eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.id, current.id))).returning();

    await recomputeCatalogInventoryTotals(tenantId, current.productId);
    await writeAuditLog({
      actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, tenantId,
      action: "INVENTORY_BALANCE_QUARANTINED", resourceType: "inventory_balance", resourceId: String(current.id),
      metadata: { productId: current.productId, locationId: current.locationId, reason: body.data.reason ?? null }, ipAddress: req.ip,
    });
    res.json({ balance: updated });
  }
);

// ─── POST /api/admin/inventory/balances/:id/classify ─────────────────────────
router.post(
  "/admin/inventory/balances/:id/classify",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const params = balanceIdParams.safeParse(req.params);
    const body = classifyBody.safeParse(req.body);
    if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
    if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
    const tenantId = await resolveInventoryTenantId(req);
    const [current] = await db.select().from(inventoryBalancesTable)
      .where(and(eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.id, params.data.id)))
      .limit(1);
    if (!current) { res.status(404).json({ error: "Balance not found for this tenant" }); return; }

    const isSupply = body.data.inventoryKind === INVENTORY_KIND_NON_SELLABLE_SUPPLY;
    const [updated] = await db.update(inventoryBalancesTable).set({
      inventoryKind: body.data.inventoryKind,
      isSellable: !isSupply,
      quarantinedAt: isSupply ? current.quarantinedAt : null,
      quarantinedByUserId: isSupply ? current.quarantinedByUserId : null,
      quarantineReason: isSupply ? current.quarantineReason : null,
    }).where(and(eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.id, current.id))).returning();

    await recomputeCatalogInventoryTotals(tenantId, current.productId);
    await writeAuditLog({
      actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, tenantId,
      action: isSupply ? "INVENTORY_BALANCE_CLASSIFIED_NON_SELLABLE" : "INVENTORY_BALANCE_RESTORED_SELLABLE",
      resourceType: "inventory_balance", resourceId: String(current.id),
      metadata: { productId: current.productId, locationId: current.locationId, from: current.inventoryKind, to: body.data.inventoryKind }, ipAddress: req.ip,
    });
    res.json({ balance: updated });
  }
);

// ─── GET /api/admin/inventory ─────────────────────────────────────────────────
// Returns all non-WooManaged catalog products with per-location breakdown from
// inventory_balances, plus the list of active locations and petty cash total.
router.get(
  "/admin/inventory",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const houseTenantId = await resolveInventoryTenantId(req);
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
        .where(and(eq(inventoryBalancesTable.tenantId, houseTenantId), sellableBalanceWhere())),
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

    const parsedBody = z.object({
      qty: z.number().finite().min(0).max(1_000_000).optional(),
      par: z.number().finite().min(0).max(1_000_000).optional(),
    }).strict().safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.message });
      return;
    }
    const { qty, par } = parsedBody.data;
    const houseTenantId = await getHouseTenantId();

    const [product] = await db
      .select({ id: catalogItemsTable.id })
      .from(catalogItemsTable)
      .where(and(
        eq(catalogItemsTable.tenantId, houseTenantId),
        eq(catalogItemsTable.id, productId),
      ))
      .limit(1);
    if (!product) {
      res.status(404).json({ error: "Catalog product not found for this tenant" });
      return;
    }

    const [location] = await db
      .select({ id: inventoryLocationsTable.id })
      .from(inventoryLocationsTable)
      .where(and(
        eq(inventoryLocationsTable.tenantId, houseTenantId),
        eq(inventoryLocationsTable.id, locationId),
      ))
      .limit(1);
    if (!location) {
      res.status(404).json({ error: "Inventory location not found for this tenant" });
      return;
    }

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

    await recomputeCatalogInventoryTotals(houseTenantId, productId);

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

    const parsedBody = z.object({
      stockQuantity: z.number().finite().min(0).max(1_000_000).nullable().optional(),
      stockUnit: z.string().trim().min(1).max(32).optional(),
      parLevel: z.number().finite().min(0).max(1_000_000).nullable().optional(),
    }).strict().safeParse(req.body);
    if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
    const { stockQuantity, stockUnit, parLevel } = parsedBody.data;

    const patch: Record<string, unknown> = {};
    if (stockQuantity !== undefined) patch.stockQuantity = stockQuantity != null ? String(stockQuantity) : null;
    if (stockUnit !== undefined) patch.stockUnit = stockUnit;
    if (parLevel !== undefined) patch.parLevel = parLevel != null ? String(parLevel) : "0";
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }

    const houseTenantId = await getHouseTenantId();
    const [updated] = await db
      .update(catalogItemsTable)
      .set(patch)
      .where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.id, id)))
      .returning({ id: catalogItemsTable.id, stockQuantity: catalogItemsTable.stockQuantity, stockUnit: catalogItemsTable.stockUnit, parLevel: catalogItemsTable.parLevel });

    if (!updated) { res.status(404).json({ error: "Item not found" }); return; }

    // Mirror catalog-level stock/par edits to the canonical Backstock balance.
    // This preserves backward-compatible edit forms while keeping inventory_balances
    // as the per-location source used by inventory, par, catalog, and order flows.
    if ((stockQuantity !== undefined && stockQuantity !== null) || (parLevel !== undefined && parLevel !== null)) {
      const [backstockLoc] = await db
        .select({ id: inventoryLocationsTable.id })
        .from(inventoryLocationsTable)
        .where(and(
          eq(inventoryLocationsTable.tenantId, houseTenantId),
          eq(inventoryLocationsTable.type, "backstock"),
        ))
        .limit(1);
      if (backstockLoc) {
        const [balance] = await db
          .select({ id: inventoryBalancesTable.id })
          .from(inventoryBalancesTable)
          .where(and(
            eq(inventoryBalancesTable.tenantId, houseTenantId),
            eq(inventoryBalancesTable.productId, id),
            eq(inventoryBalancesTable.locationId, backstockLoc.id),
          ))
          .limit(1);
        const balancePatch: Record<string, unknown> = {};
        if (stockQuantity !== undefined && stockQuantity !== null) balancePatch.quantityOnHand = String(stockQuantity);
        if (parLevel !== undefined && parLevel !== null) balancePatch.parLevel = String(parLevel);
        if (balance) {
          await db.update(inventoryBalancesTable).set(balancePatch).where(eq(inventoryBalancesTable.id, balance.id));
        } else {
          await db.insert(inventoryBalancesTable).values({
            tenantId: houseTenantId,
            productId: id,
            locationId: backstockLoc.id,
            quantityOnHand: String(stockQuantity ?? 0),
            parLevel: String(parLevel ?? 0),
          });
        }
      }
    }

    await recomputeCatalogInventoryTotals(houseTenantId, id);

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
