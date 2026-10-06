import { sql } from "drizzle-orm";
import { auditLogsTable, db } from "@workspace/db";

export const inventoryMovementTypes = [
  "receipt", "sale", "usage", "transfer_out", "transfer_in", "customer_return",
  "vendor_return", "waste", "damage", "shrinkage", "adjustment_increase",
  "adjustment_decrease", "correction",
] as const;

export type InventoryMovementType = (typeof inventoryMovementTypes)[number];
export type InventoryEntityType = "catalog" | "non_catalog";
type LedgerTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Both the root database handle and an existing transaction are valid executors. */
export type LedgerExecutor = typeof db | LedgerTransaction;

export class InventoryMovementError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "InventoryMovementError";
  }
}

export type InventoryMovementActor = { id: number; email?: string | null; role: string; ipAddress?: string | null };

export type PostInventoryMovementCommand = {
  tenantId: number;
  actor: InventoryMovementActor;
  entityType: InventoryEntityType;
  itemId: number;
  locationId: number;
  destinationLocationId?: number | null;
  movementType: InventoryMovementType;
  /** A canonical decimal string, always positive. */
  quantity: string;
  /** Required for receipts and cost-establishing inbound adjustments. */
  unitCost?: string | null;
  unitOfMeasure?: string | null;
  sourceType: string;
  sourceId?: string | null;
  orderId?: number | null;
  orderItemId?: number | null;
  receiptId?: number | null;
  supplierReference?: string | null;
  reasonCode?: string | null;
  reasonText?: string | null;
  idempotencyKey: string;
  correlationId?: string | null;
  movementIndex?: number;
  /** Only correction may supply a negative direction; all other types derive it. */
  direction?: "increase" | "decrease";
};

export type PostedInventoryMovement = {
  id: number;
  quantityDelta: string;
  preQuantity: string;
  postQuantity: string;
  unitCost: string | null;
  extendedCost: string | null;
  preAverageUnitCost: string | null;
  postAverageUnitCost: string | null;
  idempotent: boolean;
};

type SqlRow = Record<string, unknown>;
function rows<T extends SqlRow>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;
export function assertCanonicalDecimal(value: string, field: string, allowZero = false): void {
  if (!DECIMAL.test(value) || (!allowZero && /^0(?:\.0+)?$/.test(value))) {
    throw new InventoryMovementError(422, `${field} must be a finite positive decimal with at most 12 fractional digits`);
  }
}

const inbound = new Set<InventoryMovementType>(["receipt", "transfer_in", "customer_return", "adjustment_increase"]);
const outbound = new Set<InventoryMovementType>(["sale", "usage", "transfer_out", "vendor_return", "waste", "damage", "shrinkage", "adjustment_decrease"]);

function directionFor(command: PostInventoryMovementCommand): "increase" | "decrease" {
  if (inbound.has(command.movementType)) return "increase";
  if (outbound.has(command.movementType)) return "decrease";
  if (command.movementType === "correction" && command.direction) return command.direction;
  throw new InventoryMovementError(422, "Correction requires an explicit direction");
}

function asNullableDecimal(value: unknown): string | null {
  return value == null ? null : String(value);
}

export function normalizedCanonicalDecimal(value: string): string {
  const sign = value.startsWith("-") ? "-" : "";
  const raw = sign ? value.slice(1) : value;
  const [whole, fraction = ""] = raw.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return `${sign}${whole.replace(/^0+(?=\d)/, "") || "0"}${trimmedFraction ? `.${trimmedFraction}` : ""}`;
}

async function assertTenantItemAndLocation(tx: LedgerExecutor, command: PostInventoryMovementCommand): Promise<string> {
  const item = command.entityType === "catalog"
    ? rows<{ unitOfMeasure: unknown }>(await tx.execute(sql`
        SELECT COALESCE(stock_unit, unit_measurement, '#') AS "unitOfMeasure"
        FROM catalog_items WHERE tenant_id = ${command.tenantId} AND id = ${command.itemId} LIMIT 1
      `))[0]
    : rows<{ unitOfMeasure: unknown }>(await tx.execute(sql`
        SELECT unit_of_measure AS "unitOfMeasure"
        FROM non_catalog_inventory_items WHERE tenant_id = ${command.tenantId} AND id = ${command.itemId} AND is_active = true LIMIT 1
      `))[0];
  if (!item) throw new InventoryMovementError(404, "Inventory item was not found for this tenant");
  const location = rows(await tx.execute(sql`
    SELECT id FROM inventory_locations WHERE tenant_id = ${command.tenantId} AND id = ${command.locationId} AND is_active = true LIMIT 1
  `))[0];
  if (!location) throw new InventoryMovementError(404, "Active inventory location was not found for this tenant");
  if (command.destinationLocationId != null) {
    const destination = rows(await tx.execute(sql`
      SELECT id FROM inventory_locations WHERE tenant_id = ${command.tenantId} AND id = ${command.destinationLocationId} AND is_active = true LIMIT 1
    `))[0];
    if (!destination) throw new InventoryMovementError(404, "Destination inventory location was not found for this tenant");
  }
  return command.unitOfMeasure?.trim() || String(item.unitOfMeasure ?? "each");
}

async function lockBalance(tx: LedgerExecutor, command: PostInventoryMovementCommand, direction: "increase" | "decrease") {
  const catalog = command.entityType === "catalog";
  const table = catalog ? "inventory_balances" : "non_catalog_inventory_balances";
  let balance = catalog
    ? rows<{ id: number; quantity: unknown }>(await tx.execute(sql`SELECT id, quantity_on_hand AS quantity FROM inventory_balances WHERE tenant_id = ${command.tenantId} AND product_id = ${command.itemId} AND location_id = ${command.locationId} FOR UPDATE`))[0]
    : rows<{ id: number; quantity: unknown }>(await tx.execute(sql`SELECT id, quantity_on_hand AS quantity FROM non_catalog_inventory_balances WHERE tenant_id = ${command.tenantId} AND item_id = ${command.itemId} AND location_id = ${command.locationId} FOR UPDATE`))[0];
  if (!balance && direction === "increase") {
    if (command.entityType === "catalog") {
      await tx.execute(sql`
        INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity_on_hand, par_level, inventory_kind, is_sellable, updated_at)
        VALUES (${command.tenantId}, ${command.itemId}, ${command.locationId}, 0, 0, 'sellable_catalog', true, now())
        ON CONFLICT (tenant_id, product_id, location_id) DO NOTHING
      `);
    } else {
      await tx.execute(sql`
        INSERT INTO non_catalog_inventory_balances (tenant_id, item_id, location_id, quantity_on_hand, updated_at)
        VALUES (${command.tenantId}, ${command.itemId}, ${command.locationId}, 0, now())
        ON CONFLICT (tenant_id, item_id, location_id) DO NOTHING
      `);
    }
    balance = catalog
      ? rows<{ id: number; quantity: unknown }>(await tx.execute(sql`SELECT id, quantity_on_hand AS quantity FROM inventory_balances WHERE tenant_id = ${command.tenantId} AND product_id = ${command.itemId} AND location_id = ${command.locationId} FOR UPDATE`))[0]
      : rows<{ id: number; quantity: unknown }>(await tx.execute(sql`SELECT id, quantity_on_hand AS quantity FROM non_catalog_inventory_balances WHERE tenant_id = ${command.tenantId} AND item_id = ${command.itemId} AND location_id = ${command.locationId} FOR UPDATE`))[0];
  }
  if (!balance) throw new InventoryMovementError(409, "Insufficient stock at the selected location");
  return { table, id: Number(balance.id), quantity: String(balance.quantity ?? "0") };
}

async function lockValuationState(tx: LedgerExecutor, command: PostInventoryMovementCommand) {
  const catalog = command.entityType === "catalog";
  const advisoryItemKey = command.entityType === "catalog" ? command.itemId : -command.itemId;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${command.tenantId}, ${advisoryItemKey})`);
  let state = catalog
    ? rows<{ id: number; costStatus: string; knownQuantity: unknown; averageUnitCost: unknown; inventoryValue: unknown; lastPurchaseUnitCost: unknown }>(await tx.execute(sql`SELECT id, cost_status AS "costStatus", known_quantity AS "knownQuantity", average_unit_cost AS "averageUnitCost", inventory_value AS "inventoryValue", last_purchase_unit_cost AS "lastPurchaseUnitCost" FROM inventory_valuation_states WHERE tenant_id = ${command.tenantId} AND catalog_item_id = ${command.itemId} FOR UPDATE`))[0]
    : rows<{ id: number; costStatus: string; knownQuantity: unknown; averageUnitCost: unknown; inventoryValue: unknown; lastPurchaseUnitCost: unknown }>(await tx.execute(sql`SELECT id, cost_status AS "costStatus", known_quantity AS "knownQuantity", average_unit_cost AS "averageUnitCost", inventory_value AS "inventoryValue", last_purchase_unit_cost AS "lastPurchaseUnitCost" FROM inventory_valuation_states WHERE tenant_id = ${command.tenantId} AND non_catalog_item_id = ${command.itemId} FOR UPDATE`))[0];
  if (!state) {
    const physical = catalog
      ? rows<{ quantity: unknown }>(await tx.execute(sql`SELECT COALESCE(SUM(quantity_on_hand), 0) AS quantity FROM inventory_balances WHERE tenant_id = ${command.tenantId} AND product_id = ${command.itemId}`))[0]
      : rows<{ quantity: unknown }>(await tx.execute(sql`SELECT COALESCE(SUM(quantity_on_hand), 0) AS quantity FROM non_catalog_inventory_balances WHERE tenant_id = ${command.tenantId} AND item_id = ${command.itemId}`))[0];
    const status = /^0(?:\.0+)?$/.test(String(physical?.quantity ?? "0")) ? "known" : "unknown_baseline";
    await tx.execute(command.entityType === "catalog" ? sql`
      INSERT INTO inventory_valuation_states (tenant_id, inventory_entity_type, catalog_item_id, cost_status, known_quantity, inventory_value)
      VALUES (${command.tenantId}, 'catalog', ${command.itemId}, ${status}, 0, ${status === "known" ? "0" : null})
      ON CONFLICT DO NOTHING
    ` : sql`
      INSERT INTO inventory_valuation_states (tenant_id, inventory_entity_type, non_catalog_item_id, cost_status, known_quantity, inventory_value)
      VALUES (${command.tenantId}, 'non_catalog', ${command.itemId}, ${status}, 0, ${status === "known" ? "0" : null})
      ON CONFLICT DO NOTHING
    `);
    state = catalog
      ? rows<{ id: number; costStatus: string; knownQuantity: unknown; averageUnitCost: unknown; inventoryValue: unknown; lastPurchaseUnitCost: unknown }>(await tx.execute(sql`SELECT id, cost_status AS "costStatus", known_quantity AS "knownQuantity", average_unit_cost AS "averageUnitCost", inventory_value AS "inventoryValue", last_purchase_unit_cost AS "lastPurchaseUnitCost" FROM inventory_valuation_states WHERE tenant_id = ${command.tenantId} AND catalog_item_id = ${command.itemId} FOR UPDATE`))[0]
      : rows<{ id: number; costStatus: string; knownQuantity: unknown; averageUnitCost: unknown; inventoryValue: unknown; lastPurchaseUnitCost: unknown }>(await tx.execute(sql`SELECT id, cost_status AS "costStatus", known_quantity AS "knownQuantity", average_unit_cost AS "averageUnitCost", inventory_value AS "inventoryValue", last_purchase_unit_cost AS "lastPurchaseUnitCost" FROM inventory_valuation_states WHERE tenant_id = ${command.tenantId} AND non_catalog_item_id = ${command.itemId} FOR UPDATE`))[0];
  }
  if (!state) throw new Error("Could not lock inventory valuation state");
  return state;
}

async function resolveCost(tx: LedgerExecutor, command: PostInventoryMovementCommand, state: Awaited<ReturnType<typeof lockValuationState>>, direction: "increase" | "decrease"): Promise<string | null> {
  if (command.unitCost != null) {
    assertCanonicalDecimal(command.unitCost, "unitCost", true);
    return command.unitCost;
  }
  if (command.movementType === "customer_return") {
    if (!command.sourceId) throw new InventoryMovementError(422, "Customer return requires the original sale movement reference");
    const original = rows<{ unitCost: unknown }>(await tx.execute(sql`
      SELECT unit_cost AS "unitCost" FROM inventory_movements
      WHERE tenant_id = ${command.tenantId} AND id = ${Number(command.sourceId)} AND movement_type = 'sale'
      LIMIT 1
    `))[0];
    if (!original?.unitCost) throw new InventoryMovementError(409, "Original sale has no recognized inventory cost");
    return String(original.unitCost);
  }
  if (direction === "decrease") return asNullableDecimal(state.averageUnitCost);
  if (["inventory_import_baseline", "prelaunch_test_order_void"].includes(command.sourceType)) return null;
  if (command.movementType === "transfer_in" && state.costStatus !== "known") return null;
  if (state.costStatus === "known" && state.averageUnitCost != null) return String(state.averageUnitCost);
  throw new InventoryMovementError(422, "A known positive unit cost is required to establish inventory valuation");
}

async function updateValuationState(tx: LedgerExecutor, stateId: number, state: Awaited<ReturnType<typeof lockValuationState>>, quantity: string, direction: "increase" | "decrease", effectiveUnitCost: string | null, movementType: InventoryMovementType, sourceType: string) {
  const preAverage = asNullableDecimal(state.averageUnitCost);
  if (["inventory_import_baseline", "prelaunch_test_order_void"].includes(sourceType) && effectiveUnitCost == null && direction === "increase") {
    await tx.execute(sql`
      UPDATE inventory_valuation_states
      SET cost_status = 'unknown_baseline', known_quantity = 0, average_unit_cost = NULL, inventory_value = NULL, updated_at = now()
      WHERE id = ${stateId}
    `);
    return { preAverage, postAverage: null, extendedCost: null };
  }
  if (state.costStatus !== "known") {
    const updated = rows<{ averageUnitCost: unknown }>(await tx.execute(sql`
      UPDATE inventory_valuation_states
      SET last_purchase_unit_cost = CASE WHEN ${movementType} = 'receipt' THEN ${effectiveUnitCost}::numeric ELSE last_purchase_unit_cost END,
          last_purchase_at = CASE WHEN ${movementType} = 'receipt' THEN now() ELSE last_purchase_at END,
          updated_at = now()
      WHERE id = ${stateId}
      RETURNING average_unit_cost AS "averageUnitCost"
    `))[0];
    return { preAverage, postAverage: asNullableDecimal(updated?.averageUnitCost), extendedCost: null };
  }
  if (effectiveUnitCost == null) throw new InventoryMovementError(409, "Inventory valuation is unknown; a recognized cost is required");
  const updated = direction === "increase"
    ? rows<{ averageUnitCost: unknown; extendedCost: unknown }>(await tx.execute(sql`
      UPDATE inventory_valuation_states
      SET known_quantity = known_quantity + ${quantity}::numeric,
          inventory_value = round(COALESCE(inventory_value, 0) + (${quantity}::numeric * ${effectiveUnitCost}::numeric), 12),
          average_unit_cost = round((COALESCE(inventory_value, 0) + (${quantity}::numeric * ${effectiveUnitCost}::numeric)) / NULLIF(known_quantity + ${quantity}::numeric, 0), 12),
          last_purchase_unit_cost = CASE WHEN ${movementType} = 'receipt' THEN ${effectiveUnitCost}::numeric ELSE last_purchase_unit_cost END,
          last_purchase_at = CASE WHEN ${movementType} = 'receipt' THEN now() ELSE last_purchase_at END,
          updated_at = now()
      WHERE id = ${stateId}
      RETURNING average_unit_cost AS "averageUnitCost", round(${quantity}::numeric * ${effectiveUnitCost}::numeric, 12) AS "extendedCost"
    `))[0]
    : rows<{ averageUnitCost: unknown; extendedCost: unknown }>(await tx.execute(sql`
      UPDATE inventory_valuation_states
      SET known_quantity = known_quantity - ${quantity}::numeric,
          inventory_value = CASE WHEN known_quantity = ${quantity}::numeric THEN 0 ELSE round(COALESCE(inventory_value, 0) - (${quantity}::numeric * ${effectiveUnitCost}::numeric), 12) END,
          updated_at = now()
      WHERE id = ${stateId} AND known_quantity >= ${quantity}::numeric
      RETURNING average_unit_cost AS "averageUnitCost", round(${quantity}::numeric * ${effectiveUnitCost}::numeric, 12) AS "extendedCost"
    `))[0];
  if (!updated) throw new InventoryMovementError(409, "Insufficient recognized inventory valuation");
  return { preAverage, postAverage: asNullableDecimal(updated.averageUnitCost), extendedCost: asNullableDecimal(updated.extendedCost) };
}

/**
 * Posts one physical inventory movement. The caller owns the surrounding DB
 * transaction so receipts, orders, and paired transfers stay atomic.
 */
export async function postInventoryMovement(tx: LedgerExecutor, command: PostInventoryMovementCommand): Promise<PostedInventoryMovement> {
  assertCanonicalDecimal(command.quantity, "quantity");
  if (!Number.isInteger(command.itemId) || command.itemId <= 0 || !Number.isInteger(command.locationId) || command.locationId <= 0) {
    throw new InventoryMovementError(422, "Inventory item and location identifiers must be positive integers");
  }
  if (!command.idempotencyKey || command.idempotencyKey.length > 120) throw new InventoryMovementError(422, "A valid idempotency key is required");
  const index = command.movementIndex ?? 0;
  const direction = directionFor(command);
  const expectedDelta = direction === "increase" ? command.quantity : `-${command.quantity}`;
  const existing = rows<{ id: number; entityType: string; catalogItemId: number | null; nonCatalogItemId: number | null; locationId: number; movementType: string; quantityDelta: unknown; preQuantity: unknown; postQuantity: unknown; unitCost: unknown; extendedCost: unknown; preAverage: unknown; postAverage: unknown }>(await tx.execute(sql`
    SELECT id, inventory_entity_type AS "entityType", catalog_item_id AS "catalogItemId", non_catalog_item_id AS "nonCatalogItemId", location_id AS "locationId", movement_type AS "movementType", quantity_delta AS "quantityDelta", pre_quantity AS "preQuantity", post_quantity AS "postQuantity", unit_cost AS "unitCost", extended_cost AS "extendedCost", pre_average_unit_cost AS "preAverage", post_average_unit_cost AS "postAverage"
    FROM inventory_movements WHERE tenant_id = ${command.tenantId} AND idempotency_key = ${command.idempotencyKey} AND movement_index = ${index} LIMIT 1
  `))[0];
  if (existing) {
    const sameRequest = existing.entityType === command.entityType && Number(command.entityType === "catalog" ? existing.catalogItemId : existing.nonCatalogItemId) === command.itemId && Number(existing.locationId) === command.locationId && existing.movementType === command.movementType && normalizedCanonicalDecimal(String(existing.quantityDelta)) === normalizedCanonicalDecimal(expectedDelta);
    if (!sameRequest) throw new InventoryMovementError(409, "Idempotency key is already in use for a different inventory movement");
    return { id: Number(existing.id), quantityDelta: String(existing.quantityDelta), preQuantity: String(existing.preQuantity), postQuantity: String(existing.postQuantity), unitCost: asNullableDecimal(existing.unitCost), extendedCost: asNullableDecimal(existing.extendedCost), preAverageUnitCost: asNullableDecimal(existing.preAverage), postAverageUnitCost: asNullableDecimal(existing.postAverage), idempotent: true };
  }

  const unitOfMeasure = await assertTenantItemAndLocation(tx, command);
  const balance = await lockBalance(tx, command, direction);
  const state = await lockValuationState(tx, command);
  const effectiveUnitCost = await resolveCost(tx, command, state, direction);
  const valuation = await updateValuationState(tx, Number(state.id), state, command.quantity, direction, effectiveUnitCost, command.movementType, command.sourceType);
  const delta = direction === "increase" ? command.quantity : `-${command.quantity}`;
  const updatedBalance = command.entityType === "catalog"
    ? rows<{ quantity: unknown }>(await tx.execute(sql`UPDATE inventory_balances SET quantity_on_hand = quantity_on_hand + ${delta}::numeric, updated_at = now() WHERE id = ${balance.id} AND quantity_on_hand + ${delta}::numeric >= 0 RETURNING quantity_on_hand AS quantity`))[0]
    : rows<{ quantity: unknown }>(await tx.execute(sql`UPDATE non_catalog_inventory_balances SET quantity_on_hand = quantity_on_hand + ${delta}::numeric, updated_at = now() WHERE id = ${balance.id} AND quantity_on_hand + ${delta}::numeric >= 0 RETURNING quantity_on_hand AS quantity`))[0];
  if (!updatedBalance) throw new InventoryMovementError(409, "Insufficient stock at the selected location");

  const posted = rows<{ id: number }>(await tx.execute(sql`
    INSERT INTO inventory_movements (
      tenant_id, inventory_entity_type, catalog_item_id, non_catalog_item_id, location_id, destination_location_id, movement_type,
      quantity_delta, unit_of_measure, unit_cost, extended_cost, pre_quantity, post_quantity,
      pre_average_unit_cost, post_average_unit_cost, source_type, source_id, order_id, order_item_id,
      receipt_id, supplier_reference, reason_code, reason_text, idempotency_key, movement_index,
      correlation_id, actor_user_id
    ) VALUES (
      ${command.tenantId}, ${command.entityType}, ${command.entityType === "catalog" ? command.itemId : null}, ${command.entityType === "non_catalog" ? command.itemId : null}, ${command.locationId}, ${command.destinationLocationId ?? null}, ${command.movementType},
      ${delta}::numeric, ${unitOfMeasure}, ${effectiveUnitCost}::numeric, ${valuation.extendedCost}::numeric, ${balance.quantity}::numeric, ${String(updatedBalance.quantity)}::numeric,
      ${valuation.preAverage}::numeric, ${valuation.postAverage}::numeric, ${command.sourceType ?? "manual"}, ${command.sourceId ?? null}, ${command.orderId ?? null}, ${command.orderItemId ?? null},
      ${command.receiptId ?? null}, ${command.supplierReference ?? null}, ${command.reasonCode ?? null}, ${command.reasonText ?? null}, ${command.idempotencyKey}, ${index},
      ${command.correlationId ?? command.idempotencyKey}, ${command.actor.id}
    ) RETURNING id
  `))[0];
  if (!posted) throw new Error("Inventory movement insert did not return a row");
  await tx.insert(auditLogsTable).values({
    tenantId: command.tenantId, actorId: command.actor.id, actorEmail: command.actor.email ?? "", actorRole: command.actor.role,
    action: "inventory.movement_posted", resourceType: "inventory_movement", resourceId: String(posted.id),
    metadata: { movementType: command.movementType, entityType: command.entityType, itemId: command.itemId, locationId: command.locationId, quantityDelta: delta, sourceType: command.sourceType, sourceId: command.sourceId ?? null },
  });
  return { id: Number(posted.id), quantityDelta: delta, preQuantity: balance.quantity, postQuantity: String(updatedBalance.quantity), unitCost: effectiveUnitCost, extendedCost: valuation.extendedCost, preAverageUnitCost: valuation.preAverage, postAverageUnitCost: valuation.postAverage, idempotent: false };
}

export async function postInventoryMovementInTransaction(command: PostInventoryMovementCommand): Promise<PostedInventoryMovement> {
  return db.transaction((tx) => postInventoryMovement(tx, command));
}

/** Converts a legacy absolute import amount into one immutable correction. */
export async function postImportedInventoryBalanceCorrection(tx: LedgerExecutor, command: Omit<PostInventoryMovementCommand, "movementType" | "quantity" | "direction"> & { targetQuantity: string }): Promise<PostedInventoryMovement | null> {
  assertCanonicalDecimal(command.targetQuantity, "targetQuantity", true);
  const advisoryItemKey = command.entityType === "catalog" ? command.itemId : -command.itemId;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${command.tenantId}, ${advisoryItemKey})`);
  const current = command.entityType === "catalog"
    ? rows<{ quantity: unknown }>(await tx.execute(sql`SELECT COALESCE(quantity_on_hand, 0) AS quantity FROM inventory_balances WHERE tenant_id = ${command.tenantId} AND product_id = ${command.itemId} AND location_id = ${command.locationId} LIMIT 1`))[0]
    : rows<{ quantity: unknown }>(await tx.execute(sql`SELECT COALESCE(quantity_on_hand, 0) AS quantity FROM non_catalog_inventory_balances WHERE tenant_id = ${command.tenantId} AND item_id = ${command.itemId} AND location_id = ${command.locationId} LIMIT 1`))[0];
  const delta = rows<{ delta: unknown }>(await tx.execute(sql`SELECT (${command.targetQuantity}::numeric - ${String(current?.quantity ?? "0")}::numeric) AS delta`))[0];
  const deltaText = String(delta?.delta ?? "0");
  if (/^0(?:\.0+)?$/.test(deltaText)) return null;
  const negative = deltaText.startsWith("-");
  return postInventoryMovement(tx, {
    ...command, quantity: negative ? deltaText.slice(1) : deltaText, movementType: "correction", direction: negative ? "decrease" : "increase",
    reasonCode: command.reasonCode ?? "import_baseline", reasonText: command.reasonText ?? "Imported inventory baseline",
  });
}

/** Updates only the non-authoritative PAR projection while ensuring a zero row exists. */
export async function setCatalogBalanceParProjection(tx: LedgerExecutor, params: { tenantId: number; itemId: number; locationId: number; parLevel: string }): Promise<void> {
  assertCanonicalDecimal(params.parLevel, "parLevel", true);
  await tx.execute(sql`
    INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity_on_hand, par_level, inventory_kind, is_sellable, updated_at)
    VALUES (${params.tenantId}, ${params.itemId}, ${params.locationId}, 0, ${params.parLevel}::numeric, 'sellable_catalog', true, now())
    ON CONFLICT (tenant_id, product_id, location_id) DO UPDATE SET par_level = EXCLUDED.par_level, updated_at = now()
  `);
}

export async function transferInventory(tx: LedgerExecutor, command: Omit<PostInventoryMovementCommand, "movementType" | "locationId" | "destinationLocationId" | "unitCost" | "movementIndex"> & { sourceLocationId: number; destinationLocationId: number }): Promise<{ out: PostedInventoryMovement; in: PostedInventoryMovement }> {
  if (command.sourceLocationId === command.destinationLocationId) throw new InventoryMovementError(422, "Transfer source and destination must differ");
  const correlationId = command.correlationId ?? command.idempotencyKey;
  const out = await postInventoryMovement(tx, {
    ...command, locationId: command.sourceLocationId, destinationLocationId: command.destinationLocationId,
    movementType: "transfer_out", movementIndex: 0, correlationId,
  });
  const incoming = await postInventoryMovement(tx, {
    ...command, locationId: command.destinationLocationId, destinationLocationId: command.sourceLocationId,
    movementType: "transfer_in", unitCost: out.unitCost ?? undefined, movementIndex: 1, correlationId,
  });
  return { out, in: incoming };
}
