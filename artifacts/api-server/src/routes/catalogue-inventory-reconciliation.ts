import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { auditLogsTable, db } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { requirePermission } from "../lib/roles";
import { requireTenantContext } from "../lib/tenantContext";
import { postInventoryMovement } from "../lib/inventoryMovementLedger";
import { convertQuantity, convertUnitCost, reconciliationFingerprint } from "../lib/catalogueInventoryReconciliation";
import { ledgerQuantityUnits, quantityText, quantityUnits } from "../lib/exactQuantity";
import { logger } from "../lib/logger";
import {
  applyInventoryHistoryBaselineRepair,
  InventoryHistoryRepairError,
  listInventoryHistoryDiscrepancies,
  previewInventoryHistoryBaselineRepair,
} from "../lib/inventoryHistoryBaselineRepair";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext);
const admin = requireRole("global_admin", "admin", "supervisor");
const positiveId = z.number().int().positive();
const targetSchema = z.union([
  z.object({ inventoryItemId: positiveId }).strict(),
  z.object({ create: z.object({ name: z.string().trim().min(1).max(160), baseUnit: z.string().trim().min(1).max(40) }).strict() }).strict(),
]);
const previewSchema = z.object({ target: targetSchema }).strict();
const applySchema = z.object({
  target: targetSchema,
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  confirmPreview: z.literal(true),
  idempotencyKey: z.string().uuid(),
  reason: z.string().trim().min(10).max(500),
  manualUnitCost: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/).refine(value => !/^0(?:\.0+)?$/.test(value), "Cost must be positive").optional(),
  costBasisNote: z.string().trim().min(8).max(500).optional(),
}).strict();
const historyEvidenceSchema = z.object({
  inventoryItemId: positiveId,
  locationId: positiveId,
  verifiedPhysicalQuantity: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/, "Use a nonnegative quantity with no more than 6 decimal places"),
  documentedUnitCost: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/, "Use a plain nonnegative number without a currency symbol").nullable(),
  physicalCountNote: z.string().trim().min(8, "Describe the item-specific count source in at least 8 characters").max(500),
  costBasisNote: z.string().trim().min(8, "Identify the item-specific cost source or explain why cost is unknown in at least 8 characters").max(500),
}).strict();
const historyConfirmationSchema = z.object({
  inventoryItemId: positiveId,
  locationId: positiveId,
  verifiedPhysicalQuantity: z.string(),
  bridgeQuantityDelta: z.string(),
  documentedUnitCost: z.string().nullable(),
}).strict();
const historyPreviewSchema = z.object({ evidence: z.array(historyEvidenceSchema).min(1).max(200) }).strict();
const historyApplySchema = historyPreviewSchema.extend({
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  confirmedCorrections: z.array(historyConfirmationSchema).min(1).max(200),
  idempotencyKey: z.string().uuid(),
  reason: z.string().trim().min(10).max(500),
}).strict();

// SQL rows have different projections; the route validates and normalizes each field before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type ReconciliationExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseError = { code?: unknown; cause?: unknown; status?: unknown; message?: unknown; constraint?: unknown; table?: unknown; routine?: unknown };
function rows<T extends Row = Row>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}
function intArray(values: number[]) {
  return sql`ARRAY[${sql.join(values.map(value => sql`${value}`), sql`, `)}]::int[]`;
}
function previewConversion(value: string, fromUnit: string, toUnit: string): string {
  try { return convertQuantity(value, fromUnit, toUnit); }
  catch { return "Unavailable: unit conversion required"; }
}
function fail(res: import("express").Response, status: number, code: string, message: string) {
  res.status(status).json({ code, error: message });
}
function publicFailure(input: unknown, fallbackCode: string, fallbackMessage: string) {
  const error = input as DatabaseError;
  const pgError = (error?.cause as DatabaseError | undefined) ?? error;
  const sqlState = typeof pgError?.code === "string" && /^[0-9A-Z]{5}$/.test(pgError.code) ? pgError.code : null;
  logger.error({ errorType: input instanceof Error ? input.name : typeof input, sqlState, constraint: typeof pgError?.constraint === "string" ? pgError.constraint : null,
    table: typeof pgError?.table === "string" ? pgError.table : null, routine: typeof pgError?.routine === "string" ? pgError.routine : null },
    "Catalogue inventory reconciliation failed");
  if (sqlState === "40001") return { status: 409, code: "CONCURRENT_INVENTORY_CHANGE", message: "Inventory changed concurrently. Refresh the preview before retrying." };
  if (typeof error?.code === "string" && /^[A-Z][A-Z_]+$/.test(error.code) && typeof error.status === "number") {
    return { status: error.status, code: error.code, message: String(error.message ?? fallbackMessage) };
  }
  return { status: 409, code: fallbackCode, message: fallbackMessage };
}

function historyFailure(res: import("express").Response, input: unknown): void {
  if (input instanceof InventoryHistoryRepairError) {
    fail(res, input.status, input.status === 403 ? "HISTORY_REPAIR_FORBIDDEN" : input.status === 404 ? "HISTORY_REPAIR_SCOPE_NOT_FOUND" :
      input.status === 422 ? "HISTORY_REPAIR_EVIDENCE_INVALID" : "HISTORY_REPAIR_STALE", input.message);
    return;
  }
  logger.error({ errorType: input instanceof Error ? input.name : typeof input }, "Guided inventory history repair failed");
  fail(res, 409, "HISTORY_REPAIR_FAILED", "Inventory history repair failed; no changes were saved. Refresh and review a new preview.");
}

router.get("/admin/catalogue/products/:productId/inventory-history-repair", requirePermission("inventory.manage"), async (req, res): Promise<void> => {
  const productId = Number(req.params.productId);
  if (!Number.isInteger(productId) || productId <= 0) { fail(res, 400, "INVALID_PRODUCT", "Provide a valid product identifier."); return; }
  try { res.json(await listInventoryHistoryDiscrepancies(req.authorizedTenantId!, productId)); }
  catch (error) { historyFailure(res, error); }
});

router.post("/admin/catalogue/products/:productId/inventory-history-repair/preview", requirePermission("inventory.manage"), async (req, res): Promise<void> => {
  const productId = Number(req.params.productId); const parsed = historyPreviewSchema.safeParse(req.body);
  if (!Number.isInteger(productId) || productId <= 0) { fail(res, 400, "INVALID_HISTORY_REPAIR_PREVIEW", "Provide a valid product identifier."); return; }
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const rowIndex = typeof issue?.path[1] === "number" ? Number(issue.path[1]) + 1 : null;
    const field = typeof issue?.path.at(-1) === "string" ? String(issue.path.at(-1)) : "evidence";
    fail(res, 400, "INVALID_HISTORY_REPAIR_PREVIEW", `${rowIndex ? `Evidence row ${rowIndex}, ` : ""}${field}: ${issue?.message ?? "invalid value"}. No preview was created.`);
    return;
  }
  try { res.json(await previewInventoryHistoryBaselineRepair(req.authorizedTenantId!, productId, parsed.data.evidence)); }
  catch (error) { historyFailure(res, error); }
});

router.post("/admin/catalogue/products/:productId/inventory-history-repair/apply", requirePermission("inventory.manage"), async (req, res): Promise<void> => {
  const productId = Number(req.params.productId); const parsed = historyApplySchema.safeParse(req.body);
  if (!Number.isInteger(productId) || productId <= 0 || !parsed.success) { fail(res, 400, "INVALID_HISTORY_REPAIR_APPLY", "Provide the reviewed preview and confirm every exact repair."); return; }
  try {
    const result = await applyInventoryHistoryBaselineRepair({ tenantId: req.authorizedTenantId!, productId, ...parsed.data,
      actor: { id: req.dbUser!.id, email: req.dbUser!.email, role: req.dbUser!.role, ipAddress: req.ip } });
    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (error) { historyFailure(res, error); }
});

async function snapshot(executor: ReconciliationExecutor, tenantId: number, productId: number, target: z.infer<typeof targetSchema>) {
  const product = rows(await executor.execute(sql`
    SELECT id, tenant_id AS "tenantId", name, inventory_model AS "inventoryModel",
      location_evaluation AS "locationEvaluation", active
    FROM catalogue_products WHERE tenant_id=${tenantId} AND id=${productId} LIMIT 1
  `))[0];
  if (!product) throw Object.assign(new Error("Product not found"), { status: 404, code: "PRODUCT_NOT_FOUND" });
  if (product.inventoryModel !== "SEPARATE_VARIANTS") throw Object.assign(new Error("Only Separate variants products can be reconciled"), { status: 409, code: "MODEL_NOT_ELIGIBLE" });
  if (!product.active) throw Object.assign(new Error("Inactive products cannot be reconciled"), { status: 409, code: "PRODUCT_INACTIVE" });
  const variants = rows(await executor.execute(sql`
    SELECT co.id AS "optionId", co.catalog_item_id AS "catalogItemId", co.inventory_item_id AS "inventoryItemId",
      co.label, co.option_values AS "optionValues", co.consumption_quantity::text AS "consumptionQuantity",
      co.active, ci.name AS "catalogItemName", ci.sku, ci.barcode, ci.price::text AS price,
      ci.compare_at_price::text AS "compareAtPrice", ci.is_available AS "isAvailable",
      ii.catalog_item_id AS "inventoryCatalogItemId", ii.base_unit AS "baseUnit"
    FROM catalogue_options co
    JOIN catalog_items ci ON ci.tenant_id=co.tenant_id AND ci.id=co.catalog_item_id
    JOIN inventory_items ii ON ii.tenant_id=co.tenant_id AND ii.id=co.inventory_item_id
    WHERE co.tenant_id=${tenantId} AND co.product_id=${productId} AND co.active=true
    ORDER BY co.id
  `));
  if (!variants.length) throw Object.assign(new Error("Product has no active variants"), { status: 409, code: "NO_ACTIVE_VARIANTS" });
  const catalogIds = [...new Set(variants.map((v: Row) => Number(v.inventoryCatalogItemId)))].sort((a,b)=>a-b);
  let resolvedTarget: Row | undefined;
  if ("inventoryItemId" in target) {
    const targetRow = rows(await executor.execute(sql`SELECT id, catalog_item_id AS "catalogItemId", base_unit AS "baseUnit"
      FROM inventory_items WHERE tenant_id=${tenantId} AND id=${target.inventoryItemId} LIMIT 1`))[0];
    if (!targetRow || !variants.some((v: Row) => Number(v.inventoryItemId) === Number(target.inventoryItemId))) {
      throw Object.assign(new Error("Choose an inventory item already linked to an active variant of this product"), { status: 422, code: "TARGET_NOT_ELIGIBLE" });
    }
    resolvedTarget = targetRow;
  }
  const balances = rows(await executor.execute(sql`
    SELECT b.product_id AS "catalogItemId", b.location_id AS "locationId", l.name AS "locationName",
      b.quantity_on_hand::text AS quantity, b.updated_at AS "updatedAt"
    FROM inventory_balances b JOIN inventory_locations l ON l.tenant_id=b.tenant_id AND l.id=b.location_id
    WHERE b.tenant_id=${tenantId} AND b.product_id=ANY(${intArray(catalogIds)})
    ORDER BY b.product_id,b.location_id
  `));
  const reservations = rows(await executor.execute(sql`
    SELECT r.id AS "reservationId",r.catalog_item_id AS "catalogItemId",r.location_id AS "locationId",l.name AS "locationName",
      lower(r.status) AS status,r.quantity::text AS quantity,r.expires_at AS "expiresAt",r.order_id AS "orderId",lower(o.status) AS "orderStatus"
    FROM inventory_reservations r JOIN orders o ON o.id=r.order_id AND o.tenant_id=${tenantId}
    JOIN inventory_locations l ON l.tenant_id=o.tenant_id AND l.id=r.location_id
    WHERE r.catalog_item_id=ANY(${intArray(catalogIds)}) AND lower(r.status) IN ('reserved','committed','pending')
    ORDER BY r.catalog_item_id,r.location_id,r.id
  `));
  const valuation = rows(await executor.execute(sql`
    SELECT catalog_item_id AS "catalogItemId", cost_status AS "costStatus", known_quantity::text AS "knownQuantity",
      average_unit_cost::text AS "averageUnitCost", inventory_value::text AS "inventoryValue",
      last_purchase_unit_cost::text AS "lastPurchaseUnitCost", updated_at AS "updatedAt",
      (inventory_value IS NULL OR ABS(inventory_value - known_quantity * average_unit_cost) > 0.000001) AS "valuationMismatch"
    FROM inventory_valuation_states WHERE tenant_id=${tenantId} AND catalog_item_id=ANY(${intArray(catalogIds)})
  `));
  const history = rows(await executor.execute(sql`
    SELECT m.catalog_item_id AS "catalogItemId", m.location_id AS "locationId", l.name AS "locationName",
      COALESCE(SUM(m.quantity_delta),0)::text AS ledger_quantity, COUNT(m.id)::int AS "movementCount"
    FROM inventory_movements m JOIN inventory_locations l ON l.tenant_id=m.tenant_id AND l.id=m.location_id
    WHERE m.tenant_id=${tenantId} AND m.catalog_item_id=ANY(${intArray(catalogIds)})
    GROUP BY m.catalog_item_id,m.location_id,l.name ORDER BY m.catalog_item_id,m.location_id
  `));
  const hasLegacyHistory = Boolean(rows(await executor.execute(sql`SELECT to_regclass('public.inventory_transaction_log') AS table_name`))[0]?.table_name);
  const legacyHistory = hasLegacyHistory ? rows(await executor.execute(sql`
    SELECT l.catalog_item_id AS "catalogItemId", l.location_id AS "locationId",
      COUNT(*)::int AS "transactionCount", COALESCE(SUM(l.quantity_change),0)::text AS "netQuantityChange"
    FROM inventory_transaction_log l
    WHERE l.tenant_id=${tenantId} AND l.catalog_item_id=ANY(${intArray(catalogIds)})
    GROUP BY l.catalog_item_id,l.location_id ORDER BY l.catalog_item_id,l.location_id
  `)) : [];
  const foreignUse = rows(await executor.execute(sql`
    SELECT DISTINCT co.inventory_item_id AS "inventoryItemId", co.product_id AS "otherProductId"
    FROM catalogue_options co WHERE co.tenant_id=${tenantId} AND co.active=true
      AND co.inventory_item_id=ANY(${intArray([...new Set(variants.map((v: Row) => Number(v.inventoryItemId)))])})
      AND co.product_id<>${productId}
  `));
  const duplicateName = target && "create" in target ? rows(await executor.execute(sql`
    SELECT ci.id AS "catalogItemId",ii.id AS "inventoryItemId",ii.base_unit AS "baseUnit"
    FROM catalog_items ci JOIN inventory_items ii ON ii.tenant_id=ci.tenant_id AND ii.catalog_item_id=ci.id
    WHERE ci.tenant_id=${tenantId} AND lower(trim(ci.name))=lower(trim(${target.create.name}))
      AND lower(trim(ii.base_unit))=lower(trim(${target.create.baseUnit})) LIMIT 1
  `)) : [];
  const lineHistory = rows(await executor.execute(sql`
    SELECT co.id AS "optionId", COUNT(o.id)::int AS "orderLineCount"
    FROM catalogue_options co LEFT JOIN order_items oi ON oi.option_id=co.id
    LEFT JOIN orders o ON o.id=oi.order_id AND o.tenant_id=${tenantId}
    WHERE co.tenant_id=${tenantId} AND co.product_id=${productId} AND co.active=true
    GROUP BY co.id ORDER BY co.id
  `));
  const committed = rows(await executor.execute(sql`
    SELECT co.id AS "optionId", co.label, o.id AS "orderId", o.status,
      SUM(oi.quantity * co.consumption_quantity)::text AS "committedConsumption",
      COUNT(oi.id)::int AS "orderLineCount"
    FROM catalogue_options co JOIN order_items oi ON oi.option_id=co.id
    JOIN orders o ON o.id=oi.order_id AND o.tenant_id=co.tenant_id
    WHERE co.tenant_id=${tenantId} AND co.product_id=${productId} AND co.active=true
      AND lower(o.status) IN ('pending','submitted','in_progress','preparing','ready') AND o.purged_at IS NULL
    GROUP BY co.id,co.label,o.id,o.status ORDER BY co.id,o.id
  `));
  const units = resolvedTarget ? String(resolvedTarget.baseUnit)
    : "create" in target ? target.create.baseUnit : String(variants[0].baseUnit);
  const itemByCatalog = new Map<number, Row>();
  for (const v of variants) itemByCatalog.set(Number(v.inventoryCatalogItemId), v);
  const historyByKey = new Map(history.map((h: Row) => [`${h.catalogItemId}:${h.locationId}`, h]));
  const balanceRows: Row[] = balances.map((b: Row) => ({ ...b,
    ledgerQuantity: historyByKey.get(`${b.catalogItemId}:${b.locationId}`)?.ledger_quantity ?? "0",
    movementCount: historyByKey.get(`${b.catalogItemId}:${b.locationId}`)?.movementCount ?? 0,
  }));
  for (const h of history) {
    if (!balanceRows.some(b => Number(b.catalogItemId) === Number(h.catalogItemId) && Number(b.locationId) === Number(h.locationId))) {
      balanceRows.push({ catalogItemId: Number(h.catalogItemId), locationId: Number(h.locationId), locationName: h.locationName,
        quantity: "0", updatedAt: null, ledgerQuantity: h.ledger_quantity, movementCount: h.movementCount });
    }
  }
  const issues: string[] = [];
  if (product.inventoryModel === "SEPARATE_VARIANTS" && new Set(variants.map((v: Row) => Number(v.inventoryItemId))).size !== variants.length) issues.push("Separate variants already share an inventory item; resolve the conflicting mapping first.");
  if (reservations.length) issues.push("Resolve active reservations before reconciliation.");
  if (committed.length) issues.push("Resolve open orders with committed variant stock before reconciliation.");
  if (foreignUse.length) issues.push("An inventory item is also used by another active product.");
  if (duplicateName.length) issues.push(`An inventory item with that name and base unit already exists (inventory item ${duplicateName[0].inventoryItemId}); choose one of this product's linked inventory items or use another descriptive name.`);
  for (const b of balanceRows) {
    try { if (quantityUnits(String(b.quantity)) !== ledgerQuantityUnits(String(b.ledgerQuantity))) issues.push(`Inventory history does not reconcile for inventory item ${itemByCatalog.get(Number(b.catalogItemId))?.inventoryItemId ?? "?"} at location ${b.locationId}.`); }
    catch { issues.push(`Inventory history precision is unsupported for item ${itemByCatalog.get(Number(b.catalogItemId))?.inventoryItemId ?? "?"} at location ${b.locationId}.`); }
  }
  for (const v of variants) {
    try { convertQuantity(String(v.consumptionQuantity), String(v.baseUnit), units); }
    catch (e) { issues.push(`Variant ${v.optionId}: ${(e as Error).message}`); }
  }
  const itemCosts = catalogIds.map(catalogItemId => {
    const variant = itemByCatalog.get(catalogItemId)!;
    const physical = balances.filter((b: Row) => Number(b.catalogItemId) === catalogItemId).reduce((n: bigint, b: Row) => n + quantityUnits(String(b.quantity)), 0n);
    const state = valuation.find((v: Row) => Number(v.catalogItemId) === catalogItemId);
    const reliable = state?.costStatus === "known" && state.knownQuantity != null && state.averageUnitCost != null
      && !state.valuationMismatch && ledgerQuantityUnits(String(state.knownQuantity)) === physical && Number(state.averageUnitCost) > 0;
    if (physical > 0n && state?.costStatus === "known" && !reliable) issues.push(`Recorded valuation does not reconcile with on-hand stock for inventory item ${variant.inventoryItemId}.`);
    return { inventoryItemId: Number(variant.inventoryItemId), catalogItemId, baseUnit: String(variant.baseUnit), onHand: quantityText(physical), costStatus: state?.costStatus ?? (physical === 0n ? "known" : "unknown_baseline"), averageUnitCost: state?.averageUnitCost ?? null, inventoryValue: state?.inventoryValue ?? null, reliable };
  });
  const fingerprintData = {
    product, variants, balances, reservations, valuation, history, legacyHistory, foreignUse, duplicateName, lineHistory, committed,
    target: "inventoryItemId" in target ? { inventoryItemId: target.inventoryItemId } : { create: target.create },
  };
  const fingerprint = reconciliationFingerprint(fingerprintData);
  const locationIds = [...new Set(balanceRows.map((b: Row) => Number(b.locationId)))].sort((a,b)=>a-b);
  const byLocation = locationIds.map(locationId => {
    const sources = balanceRows.filter((b: Row) => Number(b.locationId) === locationId);
    let proposed = 0n; let conversionValid = true;
    for (const b of sources) {
      const source = itemByCatalog.get(Number(b.catalogItemId));
      try { proposed += quantityUnits(convertQuantity(String(b.quantity), String(source?.baseUnit), units)); }
      catch { conversionValid = false; }
    }
    return { locationId, locationName: sources[0]?.locationName ?? `Location ${locationId}`, sourceBalances: sources,
      proposedSharedBalance: conversionValid ? quantityText(proposed) : "Unavailable: unit conversion required" };
  });
  return { product, variants, balances, reservations, valuation, history, legacyHistory, lineHistory, committed, itemCosts, issues: [...new Set(issues)], targetUnit: units, locationBalances: byLocation, fingerprint, fingerprintData };
}

router.post("/admin/catalogue/products/:productId/inventory-reconciliation/preview", admin, async (req, res): Promise<void> => {
  const productId = Number(req.params.productId); const parsed = previewSchema.safeParse(req.body);
  if (!Number.isInteger(productId) || productId <= 0 || !parsed.success) { fail(res, 400, "INVALID_PREVIEW", "Provide a valid product and reconciliation target."); return; }
  try {
    const result = await snapshot(db, req.authorizedTenantId!, productId, parsed.data.target);
    const recordedCosts = result.itemCosts.map((c: Row) => {
      let convertedUnitCost: string | null = null;
      if (c.reliable) {
        try { convertedUnitCost = convertUnitCost(c.averageUnitCost, c.baseUnit, result.targetUnit); }
        catch { /* The preview already reports the unsupported unit conversion as a blocker. */ }
      }
      return { ...c, convertedUnitCost };
    });
    res.json({ product: { id: result.product.id, name: result.product.name, inventoryModel: result.product.inventoryModel,
      locationEvaluation: result.product.locationEvaluation }, target: parsed.data.target, targetUnit: result.targetUnit,
      variants: result.variants.map((v: Row) => ({ optionId: v.optionId, label: v.label, optionValues: v.optionValues,
        inventoryItemId: v.inventoryItemId, catalogItemId: v.catalogItemId, inventoryCatalogItemId: v.inventoryCatalogItemId,
        baseUnit: v.baseUnit, consumptionQuantity: v.consumptionQuantity,
        proposedConsumption: previewConversion(String(v.consumptionQuantity), String(v.baseUnit), result.targetUnit),
        price: v.price, sku: v.sku, barcode: v.barcode })),
      reservations: result.reservations, costs: recordedCosts, legacyHistory: result.legacyHistory, locations: result.locationBalances,
      orderHistory: result.lineHistory, committed: result.committed, issues: result.issues,
      costRequired: result.itemCosts.some((c: Row) => quantityUnits(String(c.onHand)) > 0n && !c.reliable)
        || !result.itemCosts.some((c: Row) => quantityUnits(String(c.onHand)) > 0n && c.reliable), fingerprint: result.fingerprint });
  } catch (e) {
    const failure = publicFailure(e, "PREVIEW_FAILED", "Inventory preview could not be completed. No changes were made.");
    fail(res, failure.status, failure.code, failure.message);
  }
});

router.post("/admin/catalogue/products/:productId/inventory-reconciliation/apply", admin, async (req, res): Promise<void> => {
  const productId = Number(req.params.productId); const parsed = applySchema.safeParse(req.body);
  if (!Number.isInteger(productId) || productId <= 0 || !parsed.success) { fail(res, 400, "INVALID_RECONCILIATION", "Confirm a valid preview and provide a reason, cost basis, and idempotency key."); return; }
  const tenantId = req.authorizedTenantId!; const body = parsed.data;
  try {
    const result = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}, ${productId})`);
      const prior = rows(await tx.execute(sql`SELECT id,product_id AS "productId",preview_fingerprint AS "previewFingerprint", evidence
        FROM catalogue_inventory_reconciliation_events WHERE tenant_id=${tenantId} AND idempotency_key=${body.idempotencyKey} LIMIT 1`))[0];
      if (prior) {
        if (Number(prior.productId) !== productId || prior.previewFingerprint !== body.previewFingerprint || prior.evidence?.operation === "rollback") {
          throw Object.assign(new Error("Idempotency key was already used for a different operation"), { status: 409, code: "IDEMPOTENCY_CONFLICT" });
        }
        return { id: prior.id, evidence: prior.evidence, idempotent: true };
      }
      const lockedProduct = rows(await tx.execute(sql`SELECT id FROM catalogue_products WHERE tenant_id=${tenantId} AND id=${productId} FOR UPDATE`))[0];
      if (!lockedProduct) throw Object.assign(new Error("Product not found"), { status: 404, code: "PRODUCT_NOT_FOUND" });
      await tx.execute(sql`SELECT co.id FROM catalogue_options co WHERE co.tenant_id=${tenantId} AND co.product_id=${productId} ORDER BY co.id FOR UPDATE`);
      await tx.execute(sql`SELECT ii.id FROM inventory_items ii JOIN catalogue_options co ON co.tenant_id=ii.tenant_id AND co.inventory_item_id=ii.id
        WHERE co.tenant_id=${tenantId} AND co.product_id=${productId} ORDER BY ii.id FOR UPDATE OF ii`);
      const lockedCatalogIds = rows<{ catalogItemId: number }>(await tx.execute(sql`SELECT DISTINCT ii.catalog_item_id AS "catalogItemId"
        FROM inventory_items ii JOIN catalogue_options co ON co.tenant_id=ii.tenant_id AND co.inventory_item_id=ii.id
        WHERE co.tenant_id=${tenantId} AND co.product_id=${productId} ORDER BY ii.catalog_item_id`)).map(r => Number(r.catalogItemId));
      if ("create" in body.target) await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}, 740016)`);
      await tx.execute(sql`SELECT id FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=ANY(${intArray(lockedCatalogIds)}) ORDER BY product_id,location_id FOR UPDATE`);
      // Match postInventoryMovement's balance-row then item-advisory lock order.
      // Reversing this order can deadlock with an in-flight inventory movement.
      for (const catalogItemId of lockedCatalogIds) await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}, ${catalogItemId})`);
      await tx.execute(sql`SELECT id FROM inventory_valuation_states WHERE tenant_id=${tenantId} AND catalog_item_id=ANY(${intArray(lockedCatalogIds)}) ORDER BY catalog_item_id FOR UPDATE`);
      const pre = await snapshot(tx, tenantId, productId, body.target);
      if (pre.fingerprint !== body.previewFingerprint) throw Object.assign(new Error("Inventory changed after preview. Refresh and review the new preview."), { status: 409, code: "STALE_PREVIEW" });
      if (pre.issues.length) throw Object.assign(new Error(pre.issues.join(" ")), { status: 409, code: "RECONCILIATION_BLOCKED" });
      const unknown = pre.itemCosts.filter((c: Row) => quantityUnits(String(c.onHand)) > 0n && !c.reliable);
      const manualCostRequired = unknown.length > 0 || !pre.itemCosts.some((c: Row) => quantityUnits(String(c.onHand)) > 0n && c.reliable);
      if (manualCostRequired && (!body.manualUnitCost || !body.costBasisNote)) throw Object.assign(new Error("Enter a documented positive cost in the proposed shared base unit; retail prices cannot establish inventory cost."), { status: 422, code: "VERIFIED_COST_REQUIRED" });
      const allItems = [...new Set(pre.itemCosts.map((c: Row) => c.catalogItemId))].sort((a:number,b:number)=>a-b);
      await tx.execute(sql`SELECT id FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=ANY(${intArray(allItems)}) ORDER BY product_id,location_id FOR UPDATE`);
      const eventId = randomUUID();
      let targetInventoryItemId: number; let targetCatalogItemId: number; let targetUnit: string;
      if ("inventoryItemId" in body.target) {
        const target = rows(await tx.execute(sql`SELECT id, catalog_item_id AS "catalogItemId", base_unit AS "baseUnit"
          FROM inventory_items WHERE tenant_id=${tenantId} AND id=${body.target.inventoryItemId} FOR UPDATE`))[0];
        if (!target) throw Object.assign(new Error("Target inventory item no longer exists"), { status: 409, code: "TARGET_CHANGED" });
        targetInventoryItemId = Number(target.id); targetCatalogItemId = Number(target.catalogItemId); targetUnit = String(target.baseUnit);
      } else {
        targetUnit = body.target.create.baseUnit;
        const catalog = rows(await tx.execute(sql`INSERT INTO catalog_items
          (tenant_id,name,category,price,merchant_brand,customer_safe_name,customer_safe_description,display_category,
           alavont_name,lucifer_cruz_name,merchant_name,stock_unit,is_available)
          VALUES (${tenantId},${body.target.create.name},'Inventory',0,'lucifer_cruz',${body.target.create.name},
            'Inventory pooling item created by audited variant reconciliation','Inventory',${body.target.create.name},
            ${body.target.create.name},${body.target.create.name},${targetUnit},false) RETURNING id`))[0];
        const created = rows(await tx.execute(sql`SELECT co.inventory_item_id AS "inventoryItemId"
          FROM catalogue_options co JOIN inventory_items ii ON ii.tenant_id=co.tenant_id AND ii.id=co.inventory_item_id
          WHERE co.tenant_id=${tenantId} AND co.catalog_item_id=${catalog.id}`))[0];
        if (!created) throw new Error("Could not create the shared inventory item");
        targetCatalogItemId = Number(catalog.id); targetInventoryItemId = Number(created.inventoryItemId);
        await tx.execute(sql`UPDATE catalogue_products SET active=false WHERE tenant_id=${tenantId} AND id=(SELECT product_id FROM catalogue_options WHERE tenant_id=${tenantId} AND catalog_item_id=${catalog.id})`);
        await tx.execute(sql`UPDATE catalogue_options SET active=false WHERE tenant_id=${tenantId} AND catalog_item_id=${catalog.id}`);
      }
      const evidence: Row = { targetInventoryItemId, targetCatalogItemId, targetUnit, reason: body.reason,
        costBasis: manualCostRequired ? { kind: "operator_documented", unitCost: body.manualUnitCost, note: body.costBasisNote } : { kind: "recorded_valuation" },
        before: { product: pre.product, variants: pre.variants, balances: pre.balances, valuation: pre.valuation }, movements: [] };
      // Record exists before the model transition. The enclosing transaction makes
      // this audit event and every inventory/link change atomic.
      await tx.execute(sql`INSERT INTO catalogue_inventory_reconciliation_events
        (id,tenant_id,product_id,actor_user_id,idempotency_key,preview_fingerprint,reason,evidence,finalized_at)
        VALUES (${eventId}::uuid,${tenantId},${productId},${req.dbUser!.id},${body.idempotencyKey},${body.previewFingerprint},${body.reason},${JSON.stringify(evidence)}::jsonb,NULL)`);
      await tx.execute(sql`SELECT set_config('myorder.catalogue_inventory_reconciliation_id',${eventId},true)`);
      let movementIndex = 0;
      for (const item of (manualCostRequired ? pre.itemCosts.filter((c: Row) => quantityUnits(String(c.onHand)) > 0n && !c.reliable) : [])) {
        const itemCost = convertUnitCost(body.manualUnitCost!, targetUnit, item.baseUnit);
        await tx.execute(sql`INSERT INTO inventory_valuation_states(tenant_id,inventory_entity_type,catalog_item_id,cost_status,known_quantity,average_unit_cost,inventory_value,updated_at)
          VALUES (${tenantId},'catalog',${item.catalogItemId},'known',${item.onHand}::numeric,${itemCost}::numeric,(${item.onHand}::numeric*${itemCost}::numeric),now())
          ON CONFLICT (tenant_id,catalog_item_id) WHERE catalog_item_id IS NOT NULL DO UPDATE SET cost_status='known',known_quantity=EXCLUDED.known_quantity,average_unit_cost=EXCLUDED.average_unit_cost,inventory_value=EXCLUDED.inventory_value,updated_at=now()`);
      }
      for (const item of pre.itemCosts) {
        if (Number(item.catalogItemId) === targetCatalogItemId) continue;
        const sourceQty = quantityUnits(String(item.onHand));
        const sourceCost = item.reliable ? String(item.averageUnitCost) : convertUnitCost(body.manualUnitCost!, targetUnit, item.baseUnit);
        if (sourceQty > 0n && (!sourceCost || Number(sourceCost) <= 0)) throw Object.assign(new Error("A verified positive unit cost is required for every nonzero source balance"), { status: 422, code: "VERIFIED_COST_REQUIRED" });
        const sourceVariant = pre.variants.find((v: Row) => Number(v.inventoryCatalogItemId) === Number(item.catalogItemId));
        const sourceLocations = pre.balances.filter((b: Row) => Number(b.catalogItemId) === Number(item.catalogItemId));
        for (const balance of sourceLocations) {
          if (quantityUnits(String(balance.quantity)) <= 0n) continue;
          const targetQty = convertQuantity(String(balance.quantity), item.baseUnit, targetUnit);
          const targetCost = convertUnitCost(sourceCost, item.baseUnit, targetUnit);
          const common = { tenantId, actor: { id: req.dbUser!.id, email: req.dbUser!.email, role: req.dbUser!.role }, entityType: "catalog" as const,
            locationId: Number(balance.locationId), unitOfMeasure: String(item.baseUnit), sourceType: "catalogue_inventory_reconciliation", sourceId: eventId,
            reasonCode: "variant_inventory_reconciliation", reasonText: body.reason, correlationId: eventId };
          const out = await postInventoryMovement(tx, { ...common, itemId: Number(item.catalogItemId), movementType: "adjustment_decrease",
            quantity: String(balance.quantity), unitCost: sourceCost, idempotencyKey: `${body.idempotencyKey}:out:${item.catalogItemId}:${balance.locationId}`, movementIndex: movementIndex++ });
          const incoming = await postInventoryMovement(tx, { ...common, itemId: targetCatalogItemId, unitOfMeasure: targetUnit,
            movementType: "adjustment_increase", quantity: targetQty, unitCost: targetCost,
            idempotencyKey: `${body.idempotencyKey}:in:${item.catalogItemId}:${balance.locationId}`, movementIndex: movementIndex++ });
          evidence.movements.push({ optionId: sourceVariant?.optionId, sourceInventoryItemId: item.inventoryItemId,
            sourceCatalogItemId: item.catalogItemId, targetInventoryItemId, targetCatalogItemId, locationId: balance.locationId,
            conversion: { from: item.baseUnit, to: targetUnit, factorQuantity: targetQty }, sourceUnitCost: sourceCost, targetUnitCost: targetCost,
            before: { source: out.preQuantity, target: incoming.preQuantity }, after: { source: out.postQuantity, target: incoming.postQuantity },
            movementIds: [out.id, incoming.id] });
        }
      }
      const itemOptions = pre.variants.map((v: Row) => ({ id: v.optionId, consumption: convertQuantity(String(v.consumptionQuantity), String(v.baseUnit), targetUnit) }));
      for (const option of itemOptions) await tx.execute(sql`UPDATE catalogue_options SET inventory_item_id=${targetInventoryItemId},consumption_quantity=${option.consumption}::numeric,updated_at=now()
        WHERE tenant_id=${tenantId} AND id=${option.id} AND active=true`);
      for (const catalogId of [...new Set([...allItems, targetCatalogItemId])]) await tx.execute(sql`UPDATE catalog_items SET
        stock_quantity=COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogId}),0),
        inventory_amount=COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogId}),0),
        updated_at=now() WHERE tenant_id=${tenantId} AND id=${catalogId}`);
      await tx.execute(sql`UPDATE catalogue_products SET inventory_model='SHARED',updated_at=now() WHERE tenant_id=${tenantId} AND id=${productId}`);
      const afterBalances = rows(await tx.execute(sql`SELECT location_id AS "locationId",quantity_on_hand::text AS quantity FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${targetCatalogItemId} ORDER BY location_id`));
      evidence.after = { inventoryModel: "SHARED", activeOptionIds: pre.variants.map((v: Row) => v.optionId), targetInventoryItemId,
        targetCatalogItemId, balances: afterBalances,
        sourceBalances: rows(await tx.execute(sql`SELECT product_id AS "catalogItemId",location_id AS "locationId",quantity_on_hand::text AS quantity
          FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=ANY(${intArray([...new Set([...allItems,targetCatalogItemId])])}) ORDER BY product_id,location_id`)),
        options: itemOptions };
      await tx.execute(sql`UPDATE catalogue_inventory_reconciliation_events SET evidence=${JSON.stringify(evidence)}::jsonb,finalized_at=now() WHERE id=${eventId}::uuid AND finalized_at IS NULL`);
      await tx.insert(auditLogsTable).values({ tenantId, actorId: req.dbUser!.id, actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role, action: "CATALOGUE_INVENTORY_RECONCILED", resourceType: "catalogue_product",
        resourceId: String(productId), metadata: { reconciliationId: eventId, targetInventoryItemId, targetCatalogItemId,
          movementIds: evidence.movements.flatMap((movement: Row) => movement.movementIds), reason: body.reason } });
      return { id: eventId, evidence, idempotent: false };
    }, { isolationLevel: "read committed" });
    res.status(result.idempotent ? 200 : 201).json({ reconciliationId: result.id, idempotent: result.idempotent,
      inventoryModel: "SHARED", targetInventoryItemId: result.evidence.targetInventoryItemId });
  } catch (e) {
    const failure = publicFailure(e, "RECONCILIATION_FAILED", "Inventory reconciliation failed; no changes were saved. Refresh the preview and try again.");
    fail(res, failure.status, failure.code, failure.message);
  }
});

const rollbackSchema = z.object({ idempotencyKey: z.string().uuid(), reason: z.string().trim().min(10).max(500) }).strict();
router.post("/admin/catalogue/products/:productId/inventory-reconciliation/:reconciliationId/rollback", admin, async (req, res): Promise<void> => {
  const productId = Number(req.params.productId); const reconciliationId = z.string().uuid().safeParse(req.params.reconciliationId);
  const parsed = rollbackSchema.safeParse(req.body);
  if (!Number.isInteger(productId) || productId <= 0 || !reconciliationId.success || !parsed.success) { fail(res, 400, "INVALID_ROLLBACK", "Provide a valid reconciliation and rollback reason."); return; }
  const tenantId = req.authorizedTenantId!; const { idempotencyKey, reason } = parsed.data;
  try {
    const result = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}, ${productId})`);
      const prior = rows(await tx.execute(sql`SELECT id,product_id AS "productId",reverses_event_id AS "reversesEventId",evidence FROM catalogue_inventory_reconciliation_events
        WHERE tenant_id=${tenantId} AND idempotency_key=${idempotencyKey} LIMIT 1`))[0];
      if (prior) {
        if (Number(prior.productId) !== productId || prior.evidence?.operation !== "rollback" || prior.reversesEventId !== reconciliationId.data) {
          throw Object.assign(new Error("Idempotency key was already used for a different operation"), { status: 409, code: "IDEMPOTENCY_CONFLICT" });
        }
        return { id: prior.id, evidence: prior.evidence, idempotent: true };
      }
      const lockedProduct = rows(await tx.execute(sql`SELECT id FROM catalogue_products WHERE tenant_id=${tenantId} AND id=${productId} FOR UPDATE`))[0];
      if (!lockedProduct) throw Object.assign(new Error("Product not found"), { status: 404, code: "PRODUCT_NOT_FOUND" });
      const original = rows(await tx.execute(sql`SELECT id,created_at AS "createdAt",evidence,finalized_at AS "finalizedAt"
        FROM catalogue_inventory_reconciliation_events WHERE tenant_id=${tenantId} AND product_id=${productId} AND id=${reconciliationId.data}::uuid FOR UPDATE`))[0];
      if (!original || !original.finalizedAt || original.evidence?.operation === "rollback") throw Object.assign(new Error("Original reconciliation evidence was not found or is not complete"), { status: 404, code: "RECONCILIATION_NOT_FOUND" });
      const alreadyReversed = rows(await tx.execute(sql`SELECT id FROM catalogue_inventory_reconciliation_events WHERE reverses_event_id=${reconciliationId.data}::uuid LIMIT 1`))[0];
      if (alreadyReversed) throw Object.assign(new Error("This reconciliation has already been reversed"), { status: 409, code: "ALREADY_REVERSED" });
      const evidence = original.evidence as Row; const moves = evidence.movements as Row[];
      const affected = [...new Set([evidence.targetCatalogItemId, ...moves.map(m => Number(m.sourceCatalogItemId))])].map(Number).sort((a,b)=>a-b);
      const originalMovementIds = moves.flatMap(m => m.movementIds).map(Number);
      await tx.execute(sql`SELECT co.id FROM catalogue_options co WHERE co.tenant_id=${tenantId} AND co.product_id=${productId} ORDER BY co.id FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=ANY(${intArray(affected)}) ORDER BY product_id,location_id FOR UPDATE`);
      const laterMovement = rows(await tx.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id=${tenantId}
        AND catalog_item_id=ANY(${intArray(affected)}) AND created_at >= ${original.createdAt}
        AND NOT (id=ANY(${intArray(originalMovementIds)})) LIMIT 1`))[0];
      if (laterMovement) throw Object.assign(new Error("Inventory has changed since reconciliation; rollback is unsafe. Use a reviewed compensating adjustment."), { status: 409, code: "ROLLBACK_STALE" });
      const activeOptions = rows(await tx.execute(sql`SELECT id,inventory_item_id AS "inventoryItemId",consumption_quantity::text AS consumption
        FROM catalogue_options WHERE tenant_id=${tenantId} AND product_id=${productId} AND active=true ORDER BY id`));
      const recordedOptions = (evidence.after.options as Row[]).map(option => [Number(option.id), Number(evidence.targetInventoryItemId), String(option.consumption)]);
      const currentOptions = activeOptions.map(option => [Number(option.id), Number(option.inventoryItemId), String(option.consumption)]);
      if (JSON.stringify(currentOptions) !== JSON.stringify(recordedOptions)) throw Object.assign(new Error("Variant inventory mapping changed after reconciliation; rollback is unsafe."), { status: 409, code: "ROLLBACK_STALE" });
      const reservations = rows(await tx.execute(sql`SELECT r.id FROM inventory_reservations r JOIN orders o ON o.id=r.order_id AND o.tenant_id=${tenantId}
        WHERE r.catalog_item_id=ANY(${intArray(affected)}) AND lower(r.status) IN ('reserved','committed','pending') LIMIT 1`))[0];
      if (reservations) throw Object.assign(new Error("Active reservations prevent rollback"), { status: 409, code: "ROLLBACK_RESERVED" });
      const targetRows = rows(await tx.execute(sql`SELECT location_id AS "locationId",quantity_on_hand::text AS quantity FROM inventory_balances
        WHERE tenant_id=${tenantId} AND product_id=${evidence.targetCatalogItemId} ORDER BY location_id`));
      const expected = evidence.after.balances as Row[];
      const currentKey = JSON.stringify(targetRows.map(r => [Number(r.locationId), String(r.quantity)]));
      const expectedKey = JSON.stringify(expected.map(r => [Number(r.locationId), String(r.quantity)]));
      if (currentKey !== expectedKey) throw Object.assign(new Error("Shared item balances differ from the recorded post-reconciliation balances"), { status: 409, code: "ROLLBACK_STALE" });
      const currentAffected = rows(await tx.execute(sql`SELECT product_id AS "catalogItemId",location_id AS "locationId",quantity_on_hand::text AS quantity
        FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=ANY(${intArray(affected)}) ORDER BY product_id,location_id`));
      const currentAffectedKey = JSON.stringify(currentAffected.map(r => [Number(r.catalogItemId), Number(r.locationId), String(r.quantity)]));
      const expectedAffectedKey = JSON.stringify((evidence.after.sourceBalances as Row[]).map(r => [Number(r.catalogItemId), Number(r.locationId), String(r.quantity)]));
      if (currentAffectedKey !== expectedAffectedKey) throw Object.assign(new Error("Source inventory balances differ from the recorded post-reconciliation balances"), { status: 409, code: "ROLLBACK_STALE" });
      const eventId = randomUUID(); const rollbackEvidence: Row = { operation: "rollback", reversesEventId: reconciliationId.data, reason,
        targetInventoryItemId: evidence.targetInventoryItemId, targetCatalogItemId: evidence.targetCatalogItemId, movements: [], before: evidence.after };
      await tx.execute(sql`INSERT INTO catalogue_inventory_reconciliation_events
        (id,tenant_id,product_id,actor_user_id,idempotency_key,preview_fingerprint,reason,evidence,reverses_event_id)
        VALUES (${eventId}::uuid,${tenantId},${productId},${req.dbUser!.id},${idempotencyKey},${"0".repeat(64)},${reason},${JSON.stringify(rollbackEvidence)}::jsonb,${reconciliationId.data}::uuid)`);
      await tx.execute(sql`SELECT set_config('myorder.catalogue_inventory_reconciliation_id',${eventId},true)`);
      let index = 0;
      for (const move of moves) {
        const locationId = Number(move.locationId);
        const sourceQuantity = quantityText(quantityUnits(String(move.before.source)) - quantityUnits(String(move.after.source)));
        const targetQuantity = String(move.conversion.factorQuantity);
        const common = { tenantId, actor: { id: req.dbUser!.id, email: req.dbUser!.email, role: req.dbUser!.role }, entityType: "catalog" as const,
          locationId, sourceType: "catalogue_inventory_reconciliation_rollback", sourceId: eventId, reasonCode: "variant_inventory_reconciliation_rollback",
          reasonText: reason, correlationId: eventId };
        const restored = await postInventoryMovement(tx, { ...common, itemId: Number(move.sourceCatalogItemId), movementType: "adjustment_increase",
          quantity: sourceQuantity, unitOfMeasure: String(move.conversion.from), unitCost: String(move.sourceUnitCost),
          idempotencyKey: `${idempotencyKey}:restore:${move.sourceCatalogItemId}:${locationId}`, movementIndex: index++ });
        const removed = await postInventoryMovement(tx, { ...common, itemId: Number(move.targetCatalogItemId), movementType: "adjustment_decrease",
          quantity: targetQuantity, unitOfMeasure: String(move.conversion.to), unitCost: String(move.targetUnitCost),
          idempotencyKey: `${idempotencyKey}:remove:${move.sourceCatalogItemId}:${locationId}`, movementIndex: index++ });
        rollbackEvidence.movements.push({ sourceCatalogItemId: move.sourceCatalogItemId, targetCatalogItemId: move.targetCatalogItemId, locationId,
          before: { source: restored.preQuantity, target: removed.preQuantity }, after: { source: restored.postQuantity, target: removed.postQuantity }, movementIds: [restored.id, removed.id] });
      }
      for (const variant of evidence.before.variants as Row[]) await tx.execute(sql`UPDATE catalogue_options SET inventory_item_id=${variant.inventoryItemId},
        consumption_quantity=${variant.consumptionQuantity}::numeric,updated_at=now() WHERE tenant_id=${tenantId} AND id=${variant.optionId} AND active=true`);
      for (const catalogId of affected) await tx.execute(sql`UPDATE catalog_items SET
        stock_quantity=COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogId}),0),
        inventory_amount=COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${catalogId}),0),
        updated_at=now() WHERE tenant_id=${tenantId} AND id=${catalogId}`);
      await tx.execute(sql`UPDATE catalogue_products SET inventory_model='SEPARATE_VARIANTS',updated_at=now() WHERE tenant_id=${tenantId} AND id=${productId}`);
      rollbackEvidence.after = { inventoryModel: "SEPARATE_VARIANTS", restoredOptions: (evidence.before.variants as Row[]).map(v => v.optionId) };
      await tx.execute(sql`UPDATE catalogue_inventory_reconciliation_events SET evidence=${JSON.stringify(rollbackEvidence)}::jsonb,finalized_at=now() WHERE id=${eventId}::uuid AND finalized_at IS NULL`);
      await tx.insert(auditLogsTable).values({ tenantId, actorId: req.dbUser!.id, actorEmail: req.dbUser!.email ?? "", actorRole: req.dbUser!.role,
        action: "CATALOGUE_INVENTORY_RECONCILIATION_REVERSED", resourceType: "catalogue_product", resourceId: String(productId),
        metadata: { reconciliationId: reconciliationId.data, rollbackId: eventId, movementIds: rollbackEvidence.movements.flatMap((m: Row) => m.movementIds), reason } });
      return { id: eventId, evidence: rollbackEvidence, idempotent: false };
    }, { isolationLevel: "read committed" });
    res.status(result.idempotent ? 200 : 201).json({ rollbackId: result.id, idempotent: result.idempotent, inventoryModel: "SEPARATE_VARIANTS" });
  } catch (e) {
    const failure = publicFailure(e, "ROLLBACK_FAILED", "Rollback failed; no changes were saved. Review the current inventory before retrying.");
    fail(res, failure.status, failure.code, failure.message);
  }
});

export default router;
