import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { auditLogsTable, db } from "@workspace/db";
import { reconciliationFingerprint } from "./catalogueInventoryReconciliation";
import { ledgerQuantityUnits, quantityText, quantityUnits } from "./exactQuantity";
import { assertCanonicalDecimal } from "./inventoryMovementLedger";

export const INVENTORY_HISTORY_BASELINE_REPAIR = "INVENTORY_HISTORY_BASELINE_REPAIR" as const;

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type Actor = { id: number; email?: string | null; role: string; ipAddress?: string | null };
type Row = Record<string, unknown>;
function rows<T extends Row>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

export type InventoryHistoryCountEvidence = {
  inventoryItemId: number;
  locationId: number;
  verifiedPhysicalQuantity: string;
  documentedUnitCost: string | null;
  physicalCountNote: string;
  costBasisNote: string;
};

export type InventoryHistoryRepairConfirmation = {
  inventoryItemId: number;
  locationId: number;
  verifiedPhysicalQuantity: string;
  bridgeQuantityDelta: string;
  documentedUnitCost: string | null;
};

export type InventoryHistoryDiscrepancy = {
  inventoryItemId: number;
  catalogItemId: number;
  itemName: string;
  baseUnit: string;
  locationId: number;
  locationName: string;
  storedPhysicalQuantity: string;
  ledgerQuantity: string;
  bridgeQuantityDelta: string;
  costStatus: string;
};

export type InventoryHistoryRepairPreview = {
  tenantId: number;
  productId: number;
  productName: string;
  blockers: string[];
  blockingReservations: Array<{ reservationId: number; orderId: number; inventoryItemId: number; locationId: number; locationName: string; status: string; quantity: string; orderStatus: string }>;
  blockingOrders: Array<{ orderId: number; orderItemId: number; inventoryItemId: number; status: string; quantity: string }>;
  corrections: Array<InventoryHistoryCountEvidence & {
    catalogItemId: number;
    locationName: string;
    ledgerQuantity: string;
    bridgeQuantityDelta: string;
  }>;
  unresolvedCosts: Array<{ inventoryItemId: number; catalogItemId: number; reason: string }>;
  fingerprint: string;
};

export class InventoryHistoryRepairError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryHistoryRepairError";
  }
}

function validateEvidence(input: InventoryHistoryCountEvidence): void {
  if (!Number.isInteger(input.inventoryItemId) || input.inventoryItemId <= 0 || !Number.isInteger(input.locationId) || input.locationId <= 0) {
    throw new InventoryHistoryRepairError(422, "Inventory item and location identifiers must be positive integers");
  }
  quantityUnits(input.verifiedPhysicalQuantity);
  if (input.documentedUnitCost != null) assertCanonicalDecimal(input.documentedUnitCost, "documentedUnitCost");
  if (input.physicalCountNote.trim().length < 8 || input.costBasisNote.trim().length < 8) {
    throw new InventoryHistoryRepairError(422, "Physical-count evidence and either cost evidence or an unknown-cost explanation are required");
  }
}

type RepairStateRow = {
  inventoryItemId: unknown; catalogItemId: unknown; itemName: unknown; baseUnit: unknown; locationId: unknown; locationName: unknown;
  physicalQuantity: unknown; balanceUpdatedAt: unknown; ledgerQuantity: unknown; movementCount: unknown; latestMovementId: unknown; costStatus: unknown;
};

async function loadRepairState(tenantId: number, productId: number, executor: Executor): Promise<{ productName: string; state: RepairStateRow[] }> {
  const product = rows<{ name: unknown; inventoryModel: unknown }>(await executor.execute(sql`
    SELECT name, inventory_model AS "inventoryModel" FROM catalogue_products
    WHERE tenant_id=${tenantId} AND id=${productId} AND active=true LIMIT 1
  `))[0];
  if (!product) throw new InventoryHistoryRepairError(404, "Active catalogue product was not found for this tenant");
  if (product.inventoryModel !== "SEPARATE_VARIANTS") throw new InventoryHistoryRepairError(409, "History baseline repair is only available before separate-variant reconciliation");
  const state = rows<RepairStateRow>(await executor.execute(sql`
    WITH linked AS (
      SELECT DISTINCT ii.id AS inventory_item_id, ii.catalog_item_id, ii.base_unit, ci.name AS item_name
      FROM catalogue_options co JOIN inventory_items ii ON ii.tenant_id=co.tenant_id AND ii.id=co.inventory_item_id
      JOIN catalog_items ci ON ci.tenant_id=ii.tenant_id AND ci.id=ii.catalog_item_id
      WHERE co.tenant_id=${tenantId} AND co.product_id=${productId} AND co.active=true
    ), movement_totals AS (
      SELECT catalog_item_id,location_id,COALESCE(SUM(quantity_delta),0) AS quantity,COUNT(*)::int AS movement_count,MAX(id) AS latest_movement_id
      FROM inventory_movements WHERE tenant_id=${tenantId} GROUP BY catalog_item_id,location_id
    )
    SELECT linked.inventory_item_id AS "inventoryItemId",linked.catalog_item_id AS "catalogItemId",linked.item_name AS "itemName",
      linked.base_unit AS "baseUnit",b.location_id AS "locationId",l.name AS "locationName",
      b.quantity_on_hand::text AS "physicalQuantity",b.updated_at AS "balanceUpdatedAt",COALESCE(mt.quantity,0)::text AS "ledgerQuantity",
      COALESCE(mt.movement_count,0) AS "movementCount",mt.latest_movement_id AS "latestMovementId",
      COALESCE(v.cost_status,'unknown_baseline') AS "costStatus"
    FROM linked JOIN inventory_balances b ON b.tenant_id=${tenantId} AND b.product_id=linked.catalog_item_id
    JOIN inventory_locations l ON l.tenant_id=b.tenant_id AND l.id=b.location_id AND l.is_active=true
    LEFT JOIN movement_totals mt ON mt.catalog_item_id=b.product_id AND mt.location_id=b.location_id
    LEFT JOIN inventory_valuation_states v ON v.tenant_id=${tenantId} AND v.catalog_item_id=linked.catalog_item_id
    ORDER BY linked.inventory_item_id,b.location_id
  `));
  return { productName: String(product.name), state };
}

export async function listInventoryHistoryDiscrepancies(
  tenantId: number,
  productId: number,
  executor: Executor = db,
): Promise<{ tenantId: number; productId: number; productName: string; discrepancies: InventoryHistoryDiscrepancy[] }> {
  if (!Number.isInteger(tenantId) || tenantId <= 0 || !Number.isInteger(productId) || productId <= 0) {
    throw new InventoryHistoryRepairError(422, "Tenant and product identifiers are required");
  }
  const { productName, state } = await loadRepairState(tenantId, productId, executor);
  const discrepancies: InventoryHistoryDiscrepancy[] = [];
  for (const row of state) {
    let ledger: bigint;
    try { ledger = ledgerQuantityUnits(String(row.ledgerQuantity)); }
    catch { throw new InventoryHistoryRepairError(409, `Ledger precision exceeds the physical scale for inventory item ${row.inventoryItemId} at location ${row.locationId}.`); }
    const physical = quantityUnits(String(row.physicalQuantity));
    if (physical === ledger) continue;
    discrepancies.push({ inventoryItemId: Number(row.inventoryItemId), catalogItemId: Number(row.catalogItemId), itemName: String(row.itemName),
      baseUnit: String(row.baseUnit), locationId: Number(row.locationId), locationName: String(row.locationName),
      storedPhysicalQuantity: quantityText(physical), ledgerQuantity: quantityText(ledger), bridgeQuantityDelta: quantityText(physical - ledger),
      costStatus: String(row.costStatus) });
  }
  return { tenantId, productId, productName, discrepancies };
}

export async function previewInventoryHistoryBaselineRepair(
  tenantId: number,
  productId: number,
  evidence: InventoryHistoryCountEvidence[],
  executor: Executor = db,
): Promise<InventoryHistoryRepairPreview> {
  if (!Number.isInteger(tenantId) || tenantId <= 0 || !Number.isInteger(productId) || productId <= 0 || !evidence.length) {
    throw new InventoryHistoryRepairError(422, "Tenant, product, and verified count evidence are required");
  }
  evidence.forEach(validateEvidence);
  const keys = evidence.map(entry => `${entry.inventoryItemId}:${entry.locationId}`);
  if (new Set(keys).size !== keys.length) throw new InventoryHistoryRepairError(422, "Each inventory item and location may appear only once");

  const { productName, state } = await loadRepairState(tenantId, productId, executor);
  const supplied = new Map(evidence.map(entry => [`${entry.inventoryItemId}:${entry.locationId}`, entry]));
  const blockers: string[] = [];
  const corrections: InventoryHistoryRepairPreview["corrections"] = [];
  for (const row of state) {
    let ledger: bigint;
    try { ledger = ledgerQuantityUnits(String(row.ledgerQuantity)); }
    catch { blockers.push(`Ledger precision exceeds the physical scale for inventory item ${row.inventoryItemId} at location ${row.locationId}.`); continue; }
    const physical = quantityUnits(String(row.physicalQuantity));
    if (physical === ledger) continue;
    const entry = supplied.get(`${row.inventoryItemId}:${row.locationId}`);
    if (!entry) { blockers.push(`A verified physical count is required for inventory item ${row.inventoryItemId} at location ${row.locationId}.`); continue; }
    if (quantityUnits(entry.verifiedPhysicalQuantity) !== physical) {
      blockers.push(`Verified count for inventory item ${row.inventoryItemId} at location ${row.locationId} no longer matches the stored physical balance.`);
      continue;
    }
    if (row.costStatus !== "unknown_baseline") {
      blockers.push(`Inventory item ${row.inventoryItemId} already has recognized valuation; automatic baseline repair is refused.`);
      continue;
    }
    corrections.push({ ...entry, catalogItemId: Number(row.catalogItemId), locationName: String(row.locationName),
      ledgerQuantity: String(row.ledgerQuantity), bridgeQuantityDelta: quantityText(physical - ledger) });
  }
  for (const entry of evidence) {
    if (!state.some(row => Number(row.inventoryItemId) === entry.inventoryItemId && Number(row.locationId) === entry.locationId)) {
      blockers.push(`Inventory item ${entry.inventoryItemId} at location ${entry.locationId} is not an active balance for this product and tenant.`);
    }
  }
  const costs = new Map<number, string>();
  for (const correction of corrections) {
    const normalized = correction.documentedUnitCost == null ? "unknown" : correction.documentedUnitCost.includes(".")
      ? correction.documentedUnitCost.replace(/0+$/, "").replace(/\.$/, "")
      : correction.documentedUnitCost;
    const prior = costs.get(correction.inventoryItemId);
    if (prior != null && prior !== normalized) blockers.push(`Documented unit cost is inconsistent across locations for inventory item ${correction.inventoryItemId}.`);
    costs.set(correction.inventoryItemId, normalized);
  }
  const catalogIds = [...new Set(state.map(row => Number(row.catalogItemId)))];
  let blockingReservations: InventoryHistoryRepairPreview["blockingReservations"] = [];
  let blockingOrders: InventoryHistoryRepairPreview["blockingOrders"] = [];
  if (catalogIds.length) {
    blockingReservations = rows(await executor.execute(sql`
      SELECT r.id AS "reservationId",r.order_id AS "orderId",r.catalog_item_id AS "inventoryItemId",
        r.location_id AS "locationId",COALESCE(l.name,'Unknown location') AS "locationName",lower(r.status) AS status,
        r.quantity::text AS quantity,lower(o.status) AS "orderStatus"
      FROM inventory_reservations r JOIN orders o ON o.id=r.order_id AND o.tenant_id=${tenantId}
      LEFT JOIN inventory_locations l ON l.tenant_id=o.tenant_id AND l.id=r.location_id
      WHERE r.catalog_item_id=ANY(${sql`ARRAY[${sql.join(catalogIds.map(id => sql`${id}`), sql`, `)}]::int[]`})
        AND lower(r.status) IN ('reserved','committed','pending')
      ORDER BY r.location_id,r.order_id,r.id
    `));
    if (blockingReservations.length) blockers.push("Active reservations must resolve through the normal order lifecycle before history repair.");
    blockingOrders = rows(await executor.execute(sql`
      SELECT o.id AS "orderId",oi.id AS "orderItemId",oi.inventory_item_id AS "inventoryItemId",
        lower(o.status) AS status,oi.quantity::text AS quantity
      FROM order_items oi JOIN orders o ON o.id=oi.order_id AND o.tenant_id=${tenantId}
      WHERE oi.inventory_item_id=ANY(${sql`ARRAY[${sql.join(state.map(row => sql`${Number(row.inventoryItemId)}`), sql`, `)}]::int[]`})
        AND lower(o.status) IN ('pending','submitted','in_progress','preparing','ready') AND o.purged_at IS NULL
      ORDER BY o.id,oi.id
    `));
    if (blockingOrders.length) blockers.push("Open orders with committed variant stock must resolve before history repair.");
  }
  if (!corrections.length && !blockers.length) blockers.push("No ledger/history mismatch requires repair.");
  const unresolvedCosts = [...new Map(corrections.filter(row => row.documentedUnitCost == null).map(row => [row.inventoryItemId,
    { inventoryItemId: row.inventoryItemId, catalogItemId: row.catalogItemId, reason: row.costBasisNote }])).values()];
  const fingerprint = reconciliationFingerprint({ tenantId, productId, state, evidence: [...evidence].sort((a,b) => a.inventoryItemId-b.inventoryItemId || a.locationId-b.locationId), blockers });
  return { tenantId, productId, productName, blockers: [...new Set(blockers)], blockingReservations, blockingOrders, corrections, unresolvedCosts, fingerprint };
}

export function repairConfirmation(correction: InventoryHistoryRepairPreview["corrections"][number]): InventoryHistoryRepairConfirmation {
  return { inventoryItemId: correction.inventoryItemId, locationId: correction.locationId,
    verifiedPhysicalQuantity: correction.verifiedPhysicalQuantity, bridgeQuantityDelta: correction.bridgeQuantityDelta,
    documentedUnitCost: correction.documentedUnitCost };
}

function normalizedConfirmations(confirmations: InventoryHistoryRepairConfirmation[]): string {
  return JSON.stringify([...confirmations].sort((a,b) => a.inventoryItemId-b.inventoryItemId || a.locationId-b.locationId).map(row => ({
    inventoryItemId: Number(row.inventoryItemId), locationId: Number(row.locationId), verifiedPhysicalQuantity: String(row.verifiedPhysicalQuantity),
    bridgeQuantityDelta: String(row.bridgeQuantityDelta), documentedUnitCost: row.documentedUnitCost == null ? null : String(row.documentedUnitCost),
  })));
}

export async function applyInventoryHistoryBaselineRepair(input: {
  tenantId: number; productId: number; evidence: InventoryHistoryCountEvidence[]; previewFingerprint: string;
  confirmedCorrections: InventoryHistoryRepairConfirmation[]; idempotencyKey: string; reason: string; actor: Actor;
}): Promise<{ repairId: string; movementIds: number[]; idempotent: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(input.previewFingerprint) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey) || input.reason.trim().length < 10) {
    throw new InventoryHistoryRepairError(422, "A reviewed preview, UUID idempotency key, and repair reason are required");
  }
  if (!Number.isInteger(input.actor.id) || input.actor.id <= 0 || !["global_admin","admin","supervisor"].includes(input.actor.role)) {
    throw new InventoryHistoryRepairError(403, "Global admin, admin, or supervisor permission is required");
  }
  return db.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.tenantId},${input.productId})`);
    const authorizedActor = rows<{ id: unknown; role: unknown }>(await tx.execute(sql`
      SELECT id,role FROM users WHERE id=${input.actor.id} AND tenant_id=${input.tenantId} AND is_active=true
        AND status='approved' AND role IN ('global_admin','admin','supervisor') LIMIT 1
    `))[0];
    if (!authorizedActor || authorizedActor.role !== input.actor.role) {
      throw new InventoryHistoryRepairError(403, "Repair actor is not an approved administrator for this tenant");
    }
    const prior = rows<{ id: unknown; evidence: unknown }>(await tx.execute(sql`
      SELECT id,evidence FROM inventory_history_baseline_repair_events WHERE tenant_id=${input.tenantId} AND idempotency_key=${input.idempotencyKey} LIMIT 1
    `))[0];
    if (prior) {
      const evidence = prior.evidence as { fingerprint?: string; reason?: string; confirmedCorrections?: InventoryHistoryRepairConfirmation[]; movementIds?: number[] };
      if (evidence.fingerprint !== input.previewFingerprint || evidence.reason !== input.reason ||
        normalizedConfirmations(evidence.confirmedCorrections ?? []) !== normalizedConfirmations(input.confirmedCorrections)) {
        throw new InventoryHistoryRepairError(409, "Idempotency key was used for another repair preview");
      }
      return { repairId: String(prior.id), movementIds: evidence.movementIds ?? [], idempotent: true };
    }
    await tx.execute(sql`SELECT id FROM inventory_balances WHERE tenant_id=${input.tenantId} ORDER BY product_id,location_id FOR UPDATE`);
    const preview = await previewInventoryHistoryBaselineRepair(input.tenantId, input.productId, input.evidence, tx);
    if (preview.fingerprint !== input.previewFingerprint) throw new InventoryHistoryRepairError(409, "Inventory changed after preview; review a fresh preview");
    if (preview.blockers.length) throw new InventoryHistoryRepairError(409, preview.blockers.join(" "));
    if (normalizedConfirmations(input.confirmedCorrections) !== normalizedConfirmations(preview.corrections.map(repairConfirmation))) {
      throw new InventoryHistoryRepairError(409, "Every exact proposed history repair must be explicitly confirmed");
    }
    const repairId = randomUUID(); const movementIds: number[] = [];
    for (let index = 0; index < preview.corrections.length; index++) {
      const correction = preview.corrections[index];
      const unitCost = correction.documentedUnitCost == null ? sql`NULL` : sql`${correction.documentedUnitCost}::numeric`;
      const inserted = rows<{ id: unknown }>(await tx.execute(sql`
        INSERT INTO inventory_movements (tenant_id,inventory_entity_type,catalog_item_id,location_id,movement_type,
          quantity_delta,unit_of_measure,unit_cost,extended_cost,pre_quantity,post_quantity,pre_average_unit_cost,post_average_unit_cost,
          source_type,source_id,reason_code,reason_text,idempotency_key,movement_index,correlation_id,actor_user_id)
        SELECT ${input.tenantId},'catalog',${correction.catalogItemId},${correction.locationId},'correction',
          ${correction.bridgeQuantityDelta}::numeric,ii.base_unit,${unitCost},
          CASE WHEN ${unitCost} IS NULL THEN NULL ELSE abs(${correction.bridgeQuantityDelta}::numeric)*${unitCost} END,
          ${correction.ledgerQuantity}::numeric,${correction.verifiedPhysicalQuantity}::numeric,NULL,${unitCost},
          'verified_physical_count_history_bridge',${repairId},'verified_history_baseline',${input.reason},
          ${input.idempotencyKey},${index},${repairId},${input.actor.id}
        FROM inventory_items ii WHERE ii.tenant_id=${input.tenantId} AND ii.id=${correction.inventoryItemId}
          AND ii.catalog_item_id=${correction.catalogItemId}
        RETURNING id
      `))[0];
      if (!inserted) throw new InventoryHistoryRepairError(409, "Repair inventory identity changed concurrently");
      movementIds.push(Number(inserted.id));
    }
    for (const inventoryItemId of [...new Set(preview.corrections.filter(row => row.documentedUnitCost != null).map(row => row.inventoryItemId))]) {
      const sample = preview.corrections.find(row => row.inventoryItemId === inventoryItemId)!;
      await tx.execute(sql`
        INSERT INTO inventory_valuation_states(tenant_id,inventory_entity_type,catalog_item_id,cost_status,known_quantity,average_unit_cost,inventory_value,updated_at)
        SELECT ${input.tenantId},'catalog',${sample.catalogItemId},'known',COALESCE(SUM(b.quantity_on_hand),0),${sample.documentedUnitCost}::numeric,
          COALESCE(SUM(b.quantity_on_hand),0)*${sample.documentedUnitCost}::numeric,now()
        FROM inventory_balances b WHERE b.tenant_id=${input.tenantId} AND b.product_id=${sample.catalogItemId}
        ON CONFLICT (tenant_id,catalog_item_id) WHERE catalog_item_id IS NOT NULL DO UPDATE
          SET cost_status='known',known_quantity=EXCLUDED.known_quantity,average_unit_cost=EXCLUDED.average_unit_cost,
              inventory_value=EXCLUDED.inventory_value,updated_at=now()
      `);
    }
    const eventEvidence = { fingerprint: preview.fingerprint, reason: input.reason, counts: preview.corrections,
      confirmedCorrections: input.confirmedCorrections, unresolvedCosts: preview.unresolvedCosts, movementIds };
    await tx.execute(sql`INSERT INTO inventory_history_baseline_repair_events
      (id,tenant_id,product_id,actor_user_id,idempotency_key,preview_fingerprint,reason,evidence,finalized_at)
      VALUES (${repairId}::uuid,${input.tenantId},${input.productId},${input.actor.id},${input.idempotencyKey},${preview.fingerprint},${input.reason},${JSON.stringify(eventEvidence)}::jsonb,now())`);
    await tx.insert(auditLogsTable).values({ tenantId: input.tenantId, actorId: input.actor.id, actorEmail: input.actor.email ?? "",
      actorRole: input.actor.role, action: INVENTORY_HISTORY_BASELINE_REPAIR, resourceType: "catalogue_product", resourceId: String(input.productId),
      metadata: { repairId, movementIds, previewFingerprint: preview.fingerprint, reason: input.reason }, ipAddress: input.actor.ipAddress ?? null });
    return { repairId, movementIds, idempotent: false };
  });
}
