import { Router, type IRouter } from "express";
import { eq, and, asc, desc, gte, lte, sql } from "drizzle-orm";
import {
  db,
  catalogItemsTable,
  adminSettingsTable,
  inventoryLocationsTable,
  inventoryBalancesTable,
  nonCatalogInventorySectionsTable,
  nonCatalogInventoryItemsTable,
  nonCatalogInventoryBalancesTable,
  inventoryMovementsTable,
  inventoryReceiptsTable,
  inventoryValuationStatesTable,
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
import { ensureInventoryTransactionLogTable, replayInventoryTransaction } from "../lib/inventoryKernel";
import { InventoryMovementError, inventoryMovementTypes, normalizedCanonicalDecimal, postInventoryMovement, transferInventory } from "../lib/inventoryMovementLedger";

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
  await ensureInventoryTransactionLogTable(db);
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
const movementDecimal = z.string().trim().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/, "Must be a bounded decimal string without exponent notation");
const signedMovementDecimal = z.string().trim().regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/, "Must be a bounded decimal string without exponent notation");
const legacySignedQuantity = z.union([signedMovementDecimal, z.number().finite().refine((value) => Math.abs(value) < 1_000_000_000_000, "Quantity is out of range")]).transform((value) => typeof value === "number" ? String(value) : value);
const movementText = z.string().trim().min(1).max(120);
const movementCommandBody = z.object({
  entityType: z.enum(["catalog", "non_catalog"]), itemId: z.number().int().positive(), locationId: z.number().int().positive(),
  movementType: z.enum(["usage", "customer_return", "vendor_return", "waste", "damage", "shrinkage", "adjustment_increase", "adjustment_decrease", "correction"]),
  quantity: movementDecimal, unitCost: movementDecimal.optional(), reasonCode: z.string().trim().min(1).max(80), reasonText: z.string().trim().min(1).max(1000),
  sourceType: z.string().trim().min(1).max(80).default("admin_inventory"), sourceId: z.string().trim().max(120).optional(), idempotencyKey: movementText,
  direction: z.enum(["increase", "decrease"]).optional(),
}).strict();
const transferBody = z.object({
  entityType: z.enum(["catalog", "non_catalog"]), itemId: z.number().int().positive(), sourceLocationId: z.number().int().positive(), destinationLocationId: z.number().int().positive(),
  quantity: movementDecimal, reasonText: z.string().trim().min(1).max(1000), idempotencyKey: movementText,
}).strict();
const receiptBody = z.object({
  entityType: z.enum(["catalog", "non_catalog"]), itemId: z.number().int().positive(), locationId: z.number().int().positive(), quantity: movementDecimal, unitCost: movementDecimal,
  supplierReference: z.string().trim().max(240).optional(), reference: z.string().trim().max(240).optional(), receivedAt: z.string().datetime({ offset: true }).optional(), idempotencyKey: movementText,
}).strict();
const nonCatalogTenant = (req: import("express").Request) => req.dbUser!.tenantId ?? 0;
const nonCatalogIdParam = z.string().regex(/^[1-9]\d*$/, "A positive scalar identifier is required");
export function parseNonCatalogId(value: unknown): number | null {
  const parsed = nonCatalogIdParam.safeParse(value);
  if (!parsed.success) return null;
  const id = Number(parsed.data);
  return Number.isSafeInteger(id) ? id : null;
}

async function assertNonCatalogSection(tenantId: number, sectionId: number | null | undefined): Promise<boolean> {
  if (sectionId == null) return true;
  const section = await db.select({ id: nonCatalogInventorySectionsTable.id }).from(nonCatalogInventorySectionsTable).where(and(eq(nonCatalogInventorySectionsTable.id, sectionId), eq(nonCatalogInventorySectionsTable.tenantId, tenantId), eq(nonCatalogInventorySectionsTable.isActive, true))).limit(1);
  return section.length === 1;
}

router.get("/admin/non-catalog/sections", requirePermission("inventory.view"), async (req, res) => { const sections = await db.select().from(nonCatalogInventorySectionsTable).where(eq(nonCatalogInventorySectionsTable.tenantId, nonCatalogTenant(req))).orderBy(asc(nonCatalogInventorySectionsTable.displayOrder)); res.json({ sections }); });
router.get("/admin/non-catalog/sections/:id", requirePermission("inventory.view"), async (req, res) => { const id = parseNonCatalogId(req.params.id); if (!id) { res.status(404).json({ error: "Section not found" }); return; } const [section] = await db.select().from(nonCatalogInventorySectionsTable).where(and(eq(nonCatalogInventorySectionsTable.id, id), eq(nonCatalogInventorySectionsTable.tenantId, nonCatalogTenant(req)))).limit(1); if (!section) { res.status(404).json({ error: "Section not found" }); return; } res.json({ section }); });
router.post("/admin/non-catalog/sections", requirePermission("inventory.manage"), async (req, res) => { const parsed = nonCatalogSectionBody.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; } const [section] = await db.insert(nonCatalogInventorySectionsTable).values({ tenantId: nonCatalogTenant(req), name: parsed.data.name, displayOrder: parsed.data.displayOrder ?? 0 }).returning(); res.status(201).json({ section }); });
router.patch("/admin/non-catalog/sections/:id", requirePermission("inventory.manage"), async (req, res) => { const id = parseNonCatalogId(req.params.id); const parsed = nonCatalogSectionBody.partial().strict().safeParse(req.body); if (!id || !parsed.success || Object.keys(parsed.data).length === 0) { res.status(400).json({ error: "Invalid section patch" }); return; } const [section] = await db.update(nonCatalogInventorySectionsTable).set({ ...parsed.data, updatedAt: new Date() }).where(and(eq(nonCatalogInventorySectionsTable.id, id), eq(nonCatalogInventorySectionsTable.tenantId, nonCatalogTenant(req)))).returning(); if (!section) { res.status(404).json({ error: "Section not found" }); return; } res.json({ section }); });
router.delete("/admin/non-catalog/sections/:id", requirePermission("inventory.manage"), async (req, res) => { const id = parseNonCatalogId(req.params.id); if (!id) { res.status(404).json({ error: "Section not found" }); return; } const populated = await db.select({ id: nonCatalogInventoryItemsTable.id }).from(nonCatalogInventoryItemsTable).where(and(eq(nonCatalogInventoryItemsTable.sectionId, id), eq(nonCatalogInventoryItemsTable.tenantId, nonCatalogTenant(req)), eq(nonCatalogInventoryItemsTable.isActive, true))).limit(1); if (populated.length) { res.status(409).json({ error: "Section must have no active items before archive" }); return; } const [section] = await db.update(nonCatalogInventorySectionsTable).set({ isActive: false, updatedAt: new Date() }).where(and(eq(nonCatalogInventorySectionsTable.id, id), eq(nonCatalogInventorySectionsTable.tenantId, nonCatalogTenant(req)))).returning(); if (!section) { res.status(404).json({ error: "Section not found" }); return; } res.json({ section }); });
router.get("/admin/non-catalog/items", requirePermission("inventory.view"), async (req, res) => { const items = await db.select().from(nonCatalogInventoryItemsTable).where(eq(nonCatalogInventoryItemsTable.tenantId, nonCatalogTenant(req))); res.json({ items }); });
router.get("/admin/non-catalog/items/:id", requirePermission("inventory.view"), async (req, res) => { const id = parseNonCatalogId(req.params.id); if (!id) { res.status(404).json({ error: "Item not found" }); return; } const [item] = await db.select().from(nonCatalogInventoryItemsTable).where(and(eq(nonCatalogInventoryItemsTable.id, id), eq(nonCatalogInventoryItemsTable.tenantId, nonCatalogTenant(req)))).limit(1); if (!item) { res.status(404).json({ error: "Item not found" }); return; } res.json({ item }); });
router.post("/admin/non-catalog/items", requirePermission("inventory.manage"), async (req, res) => { const parsed = nonCatalogItemBody.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; } const p = parsed.data; const tenantId = nonCatalogTenant(req); if (!(await assertNonCatalogSection(tenantId, p.sectionId))) { res.status(404).json({ error: "Section not found" }); return; } const [item] = await db.insert(nonCatalogInventoryItemsTable).values({ tenantId, ...p, parLevel: p.parLevel == null ? undefined : String(p.parLevel), moq: p.moq == null ? undefined : String(p.moq), preferredReorderQuantity: p.preferredReorderQuantity == null ? undefined : String(p.preferredReorderQuantity), unitCost: p.unitCost == null ? p.unitCost : String(p.unitCost), createdByUserId: req.dbUser!.id }).returning(); res.status(201).json({ item }); });
router.patch("/admin/non-catalog/items/:id", requirePermission("inventory.manage"), async (req, res) => { const id = parseNonCatalogId(req.params.id); const parsed = nonCatalogItemBody.partial().strict().safeParse(req.body); if (!id || !parsed.success || Object.keys(parsed.data).length === 0) { res.status(400).json({ error: "Invalid item patch" }); return; } const p = parsed.data; const tenantId = nonCatalogTenant(req); if (!(await assertNonCatalogSection(tenantId, p.sectionId))) { res.status(404).json({ error: "Section not found" }); return; } const patch: Record<string, unknown> = { ...p, updatedAt: new Date() }; for (const key of ["parLevel", "moq", "preferredReorderQuantity", "unitCost"]) if (key in patch && patch[key] != null) patch[key] = String(patch[key]); const [item] = await db.update(nonCatalogInventoryItemsTable).set(patch).where(and(eq(nonCatalogInventoryItemsTable.id, id), eq(nonCatalogInventoryItemsTable.tenantId, tenantId))).returning(); if (!item) { res.status(404).json({ error: "Item not found" }); return; } res.json({ item }); });
router.delete("/admin/non-catalog/items/:id", requirePermission("inventory.manage"), async (req, res) => { const id = parseNonCatalogId(req.params.id); if (!id) { res.status(404).json({ error: "Item not found" }); return; } const [item] = await db.update(nonCatalogInventoryItemsTable).set({ isActive: false, updatedAt: new Date() }).where(and(eq(nonCatalogInventoryItemsTable.id, id), eq(nonCatalogInventoryItemsTable.tenantId, nonCatalogTenant(req)))).returning(); if (!item) { res.status(404).json({ error: "Item not found" }); return; } res.json({ item }); });
router.get("/admin/non-catalog/balances", requirePermission("inventory.view"), async (req, res) => { const balances = await db.select().from(nonCatalogInventoryBalancesTable).where(eq(nonCatalogInventoryBalancesTable.tenantId, nonCatalogTenant(req))); res.json({ balances }); });
router.get("/admin/non-catalog/balances/:id", requirePermission("inventory.view"), async (req, res) => { const id = parseNonCatalogId(req.params.id); if (!id) { res.status(404).json({ error: "Balance not found" }); return; } const [balance] = await db.select().from(nonCatalogInventoryBalancesTable).where(and(eq(nonCatalogInventoryBalancesTable.id, id), eq(nonCatalogInventoryBalancesTable.tenantId, nonCatalogTenant(req)))).limit(1); if (!balance) { res.status(404).json({ error: "Balance not found" }); return; } res.json({ balance }); });
router.post("/admin/non-catalog/balances/adjust", requirePermission("inventory.manage"), async (req, res) => {
  const body = z.object({ itemId: z.number().int().positive(), locationId: z.number().int().positive(), quantityDelta: legacySignedQuantity, reason: z.enum(["INITIAL", "ADJUSTMENT"]), idempotencyKey: movementText }).strict().safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const actor = req.dbUser!; const tenantId = nonCatalogTenant(req); const { itemId, locationId, reason, idempotencyKey } = body.data;
  try {
    const result = await db.transaction(async (tx) => {
      const negative = body.data.quantityDelta.startsWith("-");
      const quantity = negative ? body.data.quantityDelta.slice(1) : body.data.quantityDelta;
      const [item] = await tx.select({ unitCost: nonCatalogInventoryItemsTable.unitCost }).from(nonCatalogInventoryItemsTable).where(and(eq(nonCatalogInventoryItemsTable.tenantId, tenantId), eq(nonCatalogInventoryItemsTable.id, itemId))).limit(1);
      const movement = await postInventoryMovement(tx, {
        tenantId, actor: { id: actor.id, email: actor.email, role: actor.role, ipAddress: req.ip }, entityType: "non_catalog", itemId, locationId,
        movementType: negative ? "adjustment_decrease" : "adjustment_increase", quantity, unitCost: negative ? undefined : (item?.unitCost == null ? undefined : String(item.unitCost)),
        sourceType: "legacy_non_catalog_adjustment", reasonCode: reason, reasonText: reason === "INITIAL" ? "Legacy initial balance" : "Legacy balance adjustment", idempotencyKey,
      });
      const [balance] = await tx.select().from(nonCatalogInventoryBalancesTable).where(and(eq(nonCatalogInventoryBalancesTable.tenantId, tenantId), eq(nonCatalogInventoryBalancesTable.itemId, itemId), eq(nonCatalogInventoryBalancesTable.locationId, locationId))).limit(1);
      return { duplicate: movement.idempotent, balance, movement };
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    const status = error instanceof InventoryMovementError ? error.status : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Balance adjustment failed" });
  }
});

// ─── Slice 3 canonical movement commands ────────────────────────────────────
router.post("/admin/inventory/receipts", requirePermission("inventory.manage"), async (req, res): Promise<void> => {
  const parsed = receiptBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const actor = req.dbUser!; const tenantId = await resolveInventoryTenantId(req); const body = parsed.data;
  try {
    const result = await db.transaction(async (tx) => {
      if (body.entityType === "catalog") {
        const [validItem] = await tx.select({ id: catalogItemsTable.id }).from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, body.itemId))).limit(1);
        if (!validItem) throw new InventoryMovementError(404, "Inventory item was not found for this tenant");
        const [validLocation] = await tx.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.id, body.locationId), eq(inventoryLocationsTable.isActive, true))).limit(1);
        if (!validLocation) throw new InventoryMovementError(404, "Active inventory location was not found for this tenant");
        const [existingReceipt] = await tx.select().from(inventoryReceiptsTable).where(and(eq(inventoryReceiptsTable.tenantId, tenantId), eq(inventoryReceiptsTable.idempotencyKey, body.idempotencyKey))).limit(1);
        if (existingReceipt?.movementId) {
          const sameRequest = existingReceipt.productId === body.itemId
            && existingReceipt.locationId === body.locationId
            && normalizedCanonicalDecimal(String(existingReceipt.quantityReceived)) === normalizedCanonicalDecimal(body.quantity)
            && normalizedCanonicalDecimal(String(existingReceipt.actualUnitCost)) === normalizedCanonicalDecimal(body.unitCost)
            && (existingReceipt.supplierReference ?? null) === (body.supplierReference ?? null)
            && (existingReceipt.reference ?? null) === (body.reference ?? null);
          if (!sameRequest) throw new InventoryMovementError(409, "Idempotency key is already in use for a different inventory receipt");
          const movement = await postInventoryMovement(tx, {
            tenantId, actor: { id: actor.id, email: actor.email, role: actor.role, ipAddress: req.ip }, entityType: "catalog", itemId: body.itemId, locationId: body.locationId,
            movementType: "receipt", quantity: body.quantity, unitCost: body.unitCost, sourceType: "inventory_receipt", sourceId: String(existingReceipt.id), receiptId: existingReceipt.id,
            supplierReference: body.supplierReference ?? null, reasonCode: "receipt", reasonText: body.reference ?? "Inventory receipt", idempotencyKey: body.idempotencyKey,
          });
          return { receipt: existingReceipt, movement };
        }
        const [receipt] = await tx.insert(inventoryReceiptsTable).values({
          tenantId, productId: body.itemId, locationId: body.locationId, quantityReceived: body.quantity, quantityBefore: "0", quantityAfter: "0",
          reason: "receipt", reference: body.reference ?? null, receivedByUserId: actor.id, idempotencyKey: body.idempotencyKey,
          actualUnitCost: body.unitCost, supplierReference: body.supplierReference ?? null, receivedAt: body.receivedAt ? new Date(body.receivedAt) : new Date(),
        }).returning();
        const movement = await postInventoryMovement(tx, {
          tenantId, actor: { id: actor.id, email: actor.email, role: actor.role, ipAddress: req.ip }, entityType: "catalog", itemId: body.itemId, locationId: body.locationId,
          movementType: "receipt", quantity: body.quantity, unitCost: body.unitCost, sourceType: "inventory_receipt", sourceId: String(receipt.id), receiptId: receipt.id,
          supplierReference: body.supplierReference ?? null, reasonCode: "receipt", reasonText: body.reference ?? "Inventory receipt", idempotencyKey: body.idempotencyKey,
        });
        const [updatedReceipt] = await tx.update(inventoryReceiptsTable).set({ quantityBefore: movement.preQuantity, quantityAfter: movement.postQuantity, movementId: movement.id }).where(eq(inventoryReceiptsTable.id, receipt.id)).returning();
        return { receipt: updatedReceipt, movement };
      }
      const movement = await postInventoryMovement(tx, {
        tenantId, actor: { id: actor.id, email: actor.email, role: actor.role, ipAddress: req.ip }, entityType: "non_catalog", itemId: body.itemId, locationId: body.locationId,
        movementType: "receipt", quantity: body.quantity, unitCost: body.unitCost, sourceType: "inventory_receipt", sourceId: body.reference ?? null,
        supplierReference: body.supplierReference ?? null, reasonCode: "receipt", reasonText: body.reference ?? "Inventory receipt", idempotencyKey: body.idempotencyKey,
      });
      return { receipt: null, movement };
    });
    res.status(result.movement.idempotent ? 200 : 201).json(result);
  } catch (error) { res.status(error instanceof InventoryMovementError ? error.status : 500).json({ error: error instanceof Error ? error.message : "Receipt failed" }); }
});

router.post("/admin/inventory/movements", requirePermission("inventory.manage"), async (req, res): Promise<void> => {
  const parsed = movementCommandBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const actor = req.dbUser!; const tenantId = await resolveInventoryTenantId(req); const body = parsed.data;
  if (body.movementType === "correction" && !body.direction) { res.status(400).json({ error: "Correction requires direction" }); return; }
  try {
    const movement = await db.transaction((tx) => postInventoryMovement(tx, {
      tenantId, actor: { id: actor.id, email: actor.email, role: actor.role, ipAddress: req.ip }, entityType: body.entityType, itemId: body.itemId, locationId: body.locationId,
      movementType: body.movementType, quantity: body.quantity, unitCost: body.unitCost, sourceType: body.sourceType, sourceId: body.sourceId ?? null,
      reasonCode: body.reasonCode, reasonText: body.reasonText, idempotencyKey: body.idempotencyKey, direction: body.direction,
    }));
    res.status(movement.idempotent ? 200 : 201).json({ movement });
  } catch (error) { res.status(error instanceof InventoryMovementError ? error.status : 500).json({ error: error instanceof Error ? error.message : "Inventory movement failed" }); }
});

router.post("/admin/inventory/transfers", requirePermission("inventory.manage"), async (req, res): Promise<void> => {
  const parsed = transferBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const actor = req.dbUser!; const tenantId = await resolveInventoryTenantId(req); const body = parsed.data;
  try {
    const transfer = await db.transaction((tx) => transferInventory(tx, {
      tenantId, actor: { id: actor.id, email: actor.email, role: actor.role, ipAddress: req.ip }, entityType: body.entityType, itemId: body.itemId,
      sourceLocationId: body.sourceLocationId, destinationLocationId: body.destinationLocationId, quantity: body.quantity, sourceType: "inventory_transfer",
      reasonCode: "transfer", reasonText: body.reasonText, idempotencyKey: body.idempotencyKey,
    }));
    res.status(transfer.out.idempotent ? 200 : 201).json({ transfer });
  } catch (error) { res.status(error instanceof InventoryMovementError ? error.status : 500).json({ error: error instanceof Error ? error.message : "Inventory transfer failed" }); }
});

router.get("/admin/inventory/movements", requireRole("global_admin", "admin", "supervisor"), async (req, res): Promise<void> => {
  const query = z.object({ entityType: z.enum(["catalog", "non_catalog"]).optional(), itemId: z.coerce.number().int().positive().optional(), locationId: z.coerce.number().int().positive().optional(), movementType: z.enum(inventoryMovementTypes).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict().safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }
  const tenantId = await resolveInventoryTenantId(req); const q = query.data;
  const conditions = [eq(inventoryMovementsTable.tenantId, tenantId)];
  if (q.entityType) conditions.push(eq(inventoryMovementsTable.inventoryEntityType, q.entityType));
  if (q.itemId) conditions.push(q.entityType === "non_catalog" ? eq(inventoryMovementsTable.nonCatalogItemId, q.itemId) : eq(inventoryMovementsTable.catalogItemId, q.itemId));
  if (q.locationId) conditions.push(eq(inventoryMovementsTable.locationId, q.locationId));
  if (q.movementType) conditions.push(eq(inventoryMovementsTable.movementType, q.movementType));
  if (q.from) conditions.push(gte(inventoryMovementsTable.createdAt, new Date(q.from)));
  if (q.to) conditions.push(lte(inventoryMovementsTable.createdAt, new Date(q.to)));
  const movements = await db.select().from(inventoryMovementsTable).where(and(...conditions)).orderBy(desc(inventoryMovementsTable.createdAt), desc(inventoryMovementsTable.id)).limit(q.limit).offset(q.offset);
  res.json({ movements, limit: q.limit, offset: q.offset });
});

// The compact inventory list deliberately remains stock-focused.  This
// authenticated admin detail source is the one place the UI obtains current
// valuation and the bounded purchase/movement history for an item.
router.get("/admin/inventory/:entityType/:itemId/detail", requireRole("global_admin", "admin", "supervisor"), async (req, res): Promise<void> => {
  const params = z.object({ entityType: z.enum(["catalog", "non_catalog"]), itemId: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const tenantId = await resolveInventoryTenantId(req);
  const { entityType, itemId } = params.data;
  const [item] = entityType === "catalog"
    ? await db.select({ id: catalogItemsTable.id, name: catalogItemsTable.name, currentDefaultCost: catalogItemsTable.costBasis }).from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, itemId))).limit(1)
    : await db.select({ id: nonCatalogInventoryItemsTable.id, name: nonCatalogInventoryItemsTable.name, currentDefaultCost: nonCatalogInventoryItemsTable.unitCost }).from(nonCatalogInventoryItemsTable).where(and(eq(nonCatalogInventoryItemsTable.tenantId, tenantId), eq(nonCatalogInventoryItemsTable.id, itemId))).limit(1);
  if (!item) { res.status(404).json({ error: "Inventory item was not found for this tenant" }); return; }

  const [valuation] = await db.select().from(inventoryValuationStatesTable).where(and(
    eq(inventoryValuationStatesTable.tenantId, tenantId),
    entityType === "catalog" ? eq(inventoryValuationStatesTable.catalogItemId, itemId) : eq(inventoryValuationStatesTable.nonCatalogItemId, itemId),
  )).limit(1);
  const [physical] = entityType === "catalog"
    ? await db.select({ quantity: sql<string>`COALESCE(SUM(${inventoryBalancesTable.quantityOnHand}), 0)` }).from(inventoryBalancesTable).where(and(eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.productId, itemId)))
    : await db.select({ quantity: sql<string>`COALESCE(SUM(${nonCatalogInventoryBalancesTable.quantityOnHand}), 0)` }).from(nonCatalogInventoryBalancesTable).where(and(eq(nonCatalogInventoryBalancesTable.tenantId, tenantId), eq(nonCatalogInventoryBalancesTable.itemId, itemId)));
  const movements = await db.select({
    id: inventoryMovementsTable.id, createdAt: inventoryMovementsTable.createdAt, movementType: inventoryMovementsTable.movementType,
    quantityDelta: inventoryMovementsTable.quantityDelta, unitCost: inventoryMovementsTable.unitCost, extendedCost: inventoryMovementsTable.extendedCost,
    supplierReference: inventoryMovementsTable.supplierReference, sourceType: inventoryMovementsTable.sourceType, sourceId: inventoryMovementsTable.sourceId,
    orderId: inventoryMovementsTable.orderId, receiptId: inventoryMovementsTable.receiptId, reasonCode: inventoryMovementsTable.reasonCode,
    locationName: inventoryLocationsTable.name,
  }).from(inventoryMovementsTable).innerJoin(inventoryLocationsTable, and(eq(inventoryLocationsTable.tenantId, inventoryMovementsTable.tenantId), eq(inventoryLocationsTable.id, inventoryMovementsTable.locationId))).where(and(
    eq(inventoryMovementsTable.tenantId, tenantId),
    eq(inventoryMovementsTable.inventoryEntityType, entityType),
    entityType === "catalog" ? eq(inventoryMovementsTable.catalogItemId, itemId) : eq(inventoryMovementsTable.nonCatalogItemId, itemId),
  )).orderBy(desc(inventoryMovementsTable.createdAt), desc(inventoryMovementsTable.id)).limit(100);
  res.json({
    item: {
      ...item,
      quantityOnHand: physical?.quantity ?? "0",
      currentDefaultCost: item.currentDefaultCost ?? null,
      lastPurchaseCost: valuation?.lastPurchaseUnitCost ?? null,
      weightedAverageCost: valuation?.averageUnitCost ?? null,
      inventoryValue: valuation?.inventoryValue ?? null,
      costStatus: valuation?.costStatus ?? "unknown_baseline",
    },
    purchaseHistory: movements.filter(movement => movement.movementType === "receipt"),
    movementHistory: movements,
  });
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

// Inventory export is intentionally distinct from the catalogue configuration
// export. It reports current per-location balances; it is not an import source
// and never includes the immutable movement ledger.
router.get("/admin/inventory/export", requirePermission("inventory.view"), async (req, res): Promise<void> => {
  const tenantId = await resolveInventoryTenantId(req);
  const snapshot = await getCatalogInventorySnapshot(tenantId);
  const headers = ["Product ID", "SKU", "Product Name", "Customer-Safe Name", "Category", "Location", "Location Type", "Quantity", "Total Quantity", "PAR", "Inventory Classification"];
  const escape = (value: unknown) => {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.join(",")];
  for (const item of snapshot.items) for (const location of item.locations) {
    lines.push([item.id, item.sku ?? "", item.alavontName ?? item.name, item.customerSafeName ?? "", item.category ?? "", location.name, location.type, location.qty, item.totalStock, location.par, item.inventoryKind].map(escape).join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="inventory_export.csv"');
  res.send(lines.join("\n"));
});


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
