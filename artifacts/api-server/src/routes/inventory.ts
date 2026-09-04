import { Router, type IRouter } from "express";
import { eq, and, asc, sql } from "drizzle-orm";
import {
  db,
  catalogItemsTable,
  adminSettingsTable,
  inventoryLocationsTable,
  nonCatalogInventorySectionsTable,
  nonCatalogInventoryItemsTable,
  nonCatalogInventoryBalancesTable,
} from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { requirePermission } from "../lib/roles";
import { z } from "zod";
import { getHouseTenantId } from "../lib/singleTenant";
import {
  ensureStandardLocations,
  ensureAllInventoryRowsExistForTenant,
  getCatalogInventorySnapshot,
  recomputeCatalogInventoryTotals,
  getOrphanInventoryBalanceReport,
} from "../lib/inventoryBalances";
import {
  ensureInventoryBalanceClassificationSchema,
  getInventoryHealthReport,
} from "../lib/inventoryHealth";
import { collectPosIntegrityReport, assertPosIntegrityReport, PosIntegrityError } from "../lib/posIntegrity";
import { collectInventoryReconcileReport, reconcileInventoryState } from "../lib/inventoryAuthority";
import { replayInventoryTransaction } from "../lib/inventoryKernel";

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
  inventorySchemaEnsured = true;
}


async function resolveInventoryTenantId(req: import("express").Request): Promise<number> {
  const actor = req.dbUser!;
  if (actor.role === "global_admin") {
    const requested = req.query.tenantId ? Number(req.query.tenantId) : undefined;
    if (requested && Number.isInteger(requested) && requested > 0) return requested;
  }
  return actor.tenantId ?? await getHouseTenantId();
}

const bootstrapInventoryBody = z.object({ acknowledgmentToken: z.string().min(1) }).strict();
const forbiddenInventoryBalanceMutationMessage = "inventory_balances mutation forbidden outside bootstrap-inventory, importer, and checkout deduction";

router.use(async (_req, res, next) => {
  try {
    await ensureInventorySchema();
    next();
  } catch {
    res.status(500).json({ error: "Could not prepare inventory schema" });
  }
});

const nonCatalogSectionBody = z.object({ name: z.string().trim().min(1).max(120), displayOrder: z.number().int().min(0).max(100000).optional() }).strict();
const nonCatalogItemBody = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(2000).nullable().optional(), sectionId: z.number().int().positive().nullable().optional(), sku: z.string().max(120).nullable().optional(), barcode: z.string().max(120).nullable().optional(), unitOfMeasure: z.string().trim().min(1).max(32).optional(), parLevel: z.number().finite().min(0).max(1_000_000).optional(), moq: z.number().finite().min(0).max(1_000_000).optional(), preferredReorderQuantity: z.number().finite().min(0).max(1_000_000).optional(), unitCost: z.number().finite().min(0).max(1_000_000).nullable().optional(), supplier: z.string().max(200).nullable().optional(), supplierSku: z.string().max(120).nullable().optional(), notes: z.string().max(4000).nullable().optional(), imageUrl: z.string().url().max(2000).nullable().optional() }).strict();
const nonCatalogTenant = (req: import("express").Request) => req.dbUser!.tenantId ?? 0;

router.get("/admin/non-catalog/sections", requirePermission("inventory.view"), async (req, res) => { const sections = await db.select().from(nonCatalogInventorySectionsTable).where(eq(nonCatalogInventorySectionsTable.tenantId, nonCatalogTenant(req))).orderBy(asc(nonCatalogInventorySectionsTable.displayOrder)); res.json({ sections }); });
router.post("/admin/non-catalog/sections", requirePermission("inventory.manage"), async (req, res) => { const parsed = nonCatalogSectionBody.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; } const [section] = await db.insert(nonCatalogInventorySectionsTable).values({ tenantId: nonCatalogTenant(req), name: parsed.data.name, displayOrder: parsed.data.displayOrder ?? 0 }).returning(); res.status(201).json({ section }); });
router.patch("/admin/non-catalog/sections/:id", requirePermission("inventory.manage"), async (req, res) => { const id = Number(req.params.id); const parsed = nonCatalogSectionBody.partial().strict().safeParse(req.body); if (!Number.isInteger(id) || !parsed.success || Object.keys(parsed.data).length === 0) { res.status(400).json({ error: "Invalid section patch" }); return; } const [section] = await db.update(nonCatalogInventorySectionsTable).set({ ...parsed.data, updatedAt: new Date() }).where(and(eq(nonCatalogInventorySectionsTable.id, id), eq(nonCatalogInventorySectionsTable.tenantId, nonCatalogTenant(req)))).returning(); if (!section) { res.status(404).json({ error: "Section not found" }); return; } res.json({ section }); });
router.delete("/admin/non-catalog/sections/:id", requirePermission("inventory.manage"), async (req, res) => { const id = Number(req.params.id); const populated = await db.select({ id: nonCatalogInventoryItemsTable.id }).from(nonCatalogInventoryItemsTable).where(and(eq(nonCatalogInventoryItemsTable.sectionId, id), eq(nonCatalogInventoryItemsTable.tenantId, nonCatalogTenant(req)))).limit(1); if (populated.length) { res.status(409).json({ error: "Section must be empty before archive" }); return; } const [section] = await db.update(nonCatalogInventorySectionsTable).set({ isActive: false, updatedAt: new Date() }).where(and(eq(nonCatalogInventorySectionsTable.id, id), eq(nonCatalogInventorySectionsTable.tenantId, nonCatalogTenant(req)))).returning(); if (!section) { res.status(404).json({ error: "Section not found" }); return; } res.json({ section }); });
router.get("/admin/non-catalog/items", requirePermission("inventory.view"), async (req, res) => { const items = await db.select().from(nonCatalogInventoryItemsTable).where(eq(nonCatalogInventoryItemsTable.tenantId, nonCatalogTenant(req))); res.json({ items }); });
router.post("/admin/non-catalog/items", requirePermission("inventory.manage"), async (req, res) => { const parsed = nonCatalogItemBody.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; } const p = parsed.data; const [item] = await db.insert(nonCatalogInventoryItemsTable).values({ tenantId: nonCatalogTenant(req), ...p, parLevel: p.parLevel == null ? undefined : String(p.parLevel), moq: p.moq == null ? undefined : String(p.moq), preferredReorderQuantity: p.preferredReorderQuantity == null ? undefined : String(p.preferredReorderQuantity), unitCost: p.unitCost == null ? p.unitCost : String(p.unitCost), createdByUserId: req.dbUser!.id }).returning(); res.status(201).json({ item }); });
router.patch("/admin/non-catalog/items/:id", requirePermission("inventory.manage"), async (req, res) => { const id = Number(req.params.id); const parsed = nonCatalogItemBody.partial().strict().safeParse(req.body); if (!Number.isInteger(id) || !parsed.success || Object.keys(parsed.data).length === 0) { res.status(400).json({ error: "Invalid item patch" }); return; } const p = parsed.data; const patch: Record<string, unknown> = { ...p, updatedAt: new Date() }; for (const key of ["parLevel", "moq", "preferredReorderQuantity", "unitCost"]) if (key in patch && patch[key] != null) patch[key] = String(patch[key]); const [item] = await db.update(nonCatalogInventoryItemsTable).set(patch).where(and(eq(nonCatalogInventoryItemsTable.id, id), eq(nonCatalogInventoryItemsTable.tenantId, nonCatalogTenant(req)))).returning(); if (!item) { res.status(404).json({ error: "Item not found" }); return; } res.json({ item }); });
router.delete("/admin/non-catalog/items/:id", requirePermission("inventory.manage"), async (req, res) => { const [item] = await db.update(nonCatalogInventoryItemsTable).set({ isActive: false, updatedAt: new Date() }).where(and(eq(nonCatalogInventoryItemsTable.id, Number(req.params.id)), eq(nonCatalogInventoryItemsTable.tenantId, nonCatalogTenant(req)))).returning(); if (!item) { res.status(404).json({ error: "Item not found" }); return; } res.json({ item }); });
router.get("/admin/non-catalog/balances", requirePermission("inventory.view"), async (req, res) => { const balances = await db.select().from(nonCatalogInventoryBalancesTable).where(eq(nonCatalogInventoryBalancesTable.tenantId, nonCatalogTenant(req))); res.json({ balances }); });
router.post("/admin/non-catalog/balances/adjust", requirePermission("inventory.manage"), async (req, res) => {
  const body = z.object({ itemId: z.number().int().positive(), locationId: z.number().int().positive(), quantityDelta: z.number().finite(), reason: z.enum(["INITIAL", "ADJUSTMENT"]), idempotencyKey: z.string().trim().min(8).max(120) }).strict().safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const tenantId = nonCatalogTenant(req); const { itemId, locationId, quantityDelta, reason, idempotencyKey } = body.data;
  const result = await db.transaction(async (tx) => {
    const existing = await tx.execute(sql`SELECT id, quantity_change, after_state FROM inventory_transaction_log WHERE transaction_id = ${`noncatalog:${tenantId}:${idempotencyKey}`} LIMIT 1`);
    if (existing.rows.length) return { duplicate: true, balance: null };
    const item = await tx.select({ id: nonCatalogInventoryItemsTable.id }).from(nonCatalogInventoryItemsTable).where(and(eq(nonCatalogInventoryItemsTable.id, itemId), eq(nonCatalogInventoryItemsTable.tenantId, tenantId), eq(nonCatalogInventoryItemsTable.isActive, true))).limit(1);
    const location = await tx.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.id, locationId), eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.isActive, true))).limit(1);
    if (!item.length || !location.length) throw Object.assign(new Error("Item or location not found"), { status: 404 });
    const current = await tx.select().from(nonCatalogInventoryBalancesTable).where(and(eq(nonCatalogInventoryBalancesTable.tenantId, tenantId), eq(nonCatalogInventoryBalancesTable.itemId, itemId), eq(nonCatalogInventoryBalancesTable.locationId, locationId))).limit(1);
    const before = Number(current[0]?.quantityOnHand ?? 0); const after = before + quantityDelta; if (after < 0) throw Object.assign(new Error("Insufficient stock"), { status: 409 });
    let balance;
    if (current.length) [balance] = await tx.update(nonCatalogInventoryBalancesTable).set({ quantityOnHand: String(after), updatedAt: new Date() }).where(eq(nonCatalogInventoryBalancesTable.id, current[0].id)).returning();
    else [balance] = await tx.insert(nonCatalogInventoryBalancesTable).values({ tenantId, itemId, locationId, quantityOnHand: String(after) }).returning();
    await tx.execute(sql`INSERT INTO inventory_transaction_log (transaction_id, type, quantity_change, before_state, after_state, created_at) VALUES (${`noncatalog:${tenantId}:${idempotencyKey}`}, ${reason.toLowerCase()}, ${String(quantityDelta)}, ${JSON.stringify({ quantityOnHand: before })}::jsonb, ${JSON.stringify({ quantityOnHand: after, itemId, locationId })}::jsonb, now())`);
    return { duplicate: false, balance };
  }).catch((error: unknown) => { const status = Number((error as { status?: number }).status) || 500; res.status(status).json({ error: error instanceof Error ? error.message : "Balance adjustment failed" }); return null; });
  if (result) res.status(result.duplicate ? 200 : 201).json(result);
});



// ─── POST /api/admin/bootstrap-inventory ─────────────────────────────────────
router.post(
  "/admin/bootstrap-inventory",
  requireRole("global_admin", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const parsed = bootstrapInventoryBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const expectedToken = process.env.POS_INTEGRITY_STRICT_ACK_TOKEN ?? "POS_INTEGRITY_STRICT";
    if (parsed.data.acknowledgmentToken !== expectedToken) {
      res.status(403).json({ error: "POS_INTEGRITY_STRICT acknowledgment token required" });
      return;
    }
    try {
      const tenantId = await resolveInventoryTenantId(req);
      const result = await ensureAllInventoryRowsExistForTenant(tenantId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Inventory bootstrap failed" });
    }
  },
);

// ─── GET /api/admin/pos-integrity-report ─────────────────────────────────────
router.get(
  "/admin/pos-integrity-report",
  requireRole("global_admin", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    try {
      const tenantId = await resolveInventoryTenantId(req);
      const report = await collectPosIntegrityReport(tenantId);
      assertPosIntegrityReport(report);
      res.json(report);
    } catch (err) {
      if (err instanceof PosIntegrityError) {
        res.status(err.status).json({ error: err.message, ...err.report });
        return;
      }
      res.status(500).json({ error: "Could not build POS integrity report" });
    }
  },
);

// ─── GET /api/admin/inventory/reconcile-report ───────────────────────────────
router.get(
  "/admin/inventory/reconcile-report",
  requireRole("global_admin", "admin", "supervisor"),
  async (_req, res): Promise<void> => {
    try {
      const report = await collectInventoryReconcileReport();
      res.json({ ...report, mode: "read_only" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Could not reconcile inventory state" });
    }
  },
);

// ─── POST /api/admin/inventory/reconcile-repair ──────────────────────────────
router.post(
  "/admin/inventory/reconcile-repair",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    try {
      const report = await reconcileInventoryState();
      res.json({ ...report, mode: "repair" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Could not repair inventory reconciliation state" });
    }
  },
);

// ─── GET /api/admin/inventory/transaction/:id ────────────────────────────────
router.get(
  "/admin/inventory/transaction/:id",
  requireRole("global_admin", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    try {
      const transactionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const report = await replayInventoryTransaction(transactionId);
      res.json(report);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : "Inventory transaction was not found" });
    }
  },
);

// ─── GET /api/admin/inventory/health ─────────────────────────────────────────
router.get(
  "/admin/inventory/health",
  requirePermission("inventory.view"),
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
  async (_req, res): Promise<void> => {
    res.status(409).json({ error: forbiddenInventoryBalanceMutationMessage });
  }
);

// ─── POST /api/admin/inventory/balances/:id/classify ─────────────────────────
router.post(
  "/admin/inventory/balances/:id/classify",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    res.status(409).json({ error: forbiddenInventoryBalanceMutationMessage });
  }
);

// ─── GET /api/admin/inventory ─────────────────────────────────────────────────
// Returns all non-WooManaged catalog products with per-location breakdown from
// inventory_balances, plus the list of active locations and petty cash total.
router.get(
  "/admin/inventory",
  requirePermission("inventory.view"),
  async (req, res): Promise<void> => {
    const houseTenantId = await resolveInventoryTenantId(req);
    await ensureStandardLocations(houseTenantId);

    const [snapshot, settingsRows] = await Promise.all([
      getCatalogInventorySnapshot(houseTenantId),
      db
        .select({ pettyCash: adminSettingsTable.pettyCash })
        .from(adminSettingsTable)
        .where(eq(adminSettingsTable.tenantId, houseTenantId))
        .limit(1),
    ]);

    res.json({
      items: snapshot.items,
      locations: snapshot.locations,
      pettyCash: settingsRows[0]?.pettyCash != null ? parseFloat(String(settingsRows[0].pettyCash)) : 0,
    });
  }
);


// ─── GET /api/admin/inventory/orphans ─────────────────────────────────────────
// Admin-visible quarantine/report for balances that are not active sellable catalog stock.
router.get(
  "/admin/inventory/orphans",
  requirePermission("inventory.view"),
  async (req, res): Promise<void> => {
    const houseTenantId = await resolveInventoryTenantId(req);
    const items = await getOrphanInventoryBalanceReport(houseTenantId);
    res.json({ items, count: items.length });
  }
);

// ─── PATCH /api/admin/inventory/orphans/:id ───────────────────────────────────
router.patch(
  "/admin/inventory/orphans/:id",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    res.status(409).json({ error: forbiddenInventoryBalanceMutationMessage });
  }
);

// ─── GET /api/admin/inventory/locations ──────────────────────────────────────
router.get(
  "/admin/inventory/locations",
  requirePermission("inventory.view"),
  async (req, res): Promise<void> => {
    const houseTenantId = await resolveInventoryTenantId(req);
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
    res.status(409).json({ error: forbiddenInventoryBalanceMutationMessage, use: "/api/admin/bootstrap-inventory" });
  }
);

// ─── PATCH /api/admin/inventory/balance/:productId/:locationId ────────────────
router.patch(
  "/admin/inventory/balance/:productId/:locationId",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    res.status(409).json({ error: forbiddenInventoryBalanceMutationMessage });
  }
);

// ─── PATCH /api/admin/inventory/:id ───────────────────────────────────────────
// Update catalog-level stock_unit only. inventory_balances quantity/par edits are forbidden here.
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
    if (stockQuantity !== undefined || parLevel !== undefined) {
      res.status(409).json({ error: forbiddenInventoryBalanceMutationMessage, use: "/api/admin/bootstrap-inventory" });
      return;
    }

    const patch: Record<string, unknown> = {};
    if (stockUnit !== undefined) patch.stockUnit = stockUnit;
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }

    const houseTenantId = await getHouseTenantId();
    const [updated] = await db
      .update(catalogItemsTable)
      .set(patch)
      .where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.id, id)))
      .returning({ id: catalogItemsTable.id, stockQuantity: catalogItemsTable.stockQuantity, stockUnit: catalogItemsTable.stockUnit, parLevel: catalogItemsTable.parLevel });

    if (!updated) { res.status(404).json({ error: "Item not found" }); return; }

    // inventory_balances edits are forbidden here; use bootstrap/importer/checkout only.

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
