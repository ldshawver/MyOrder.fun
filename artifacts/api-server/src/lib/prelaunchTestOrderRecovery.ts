import { and, eq, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  inventoryReservationsTable,
  orderItemsTable,
  ordersTable,
} from "@workspace/db";
import { postInventoryMovement, type InventoryMovementActor } from "./inventoryMovementLedger";

export const PRELAUNCH_TEST_VOID_REASON = "PRE_LAUNCH_TEST_ORDER_VOID" as const;

export type PrelaunchTestVoidInput = {
  tenantId: number;
  orderId: number;
  idempotencyKey: string;
  actor: InventoryMovementActor;
};

export type PrelaunchTestVoidResult = {
  orderId: number;
  previousStatus: string;
  finalStatus: "cancelled";
  releasedReservations: number;
  reconciledReservations: number;
  restoredQuantity: string;
  unknownCostQuantity: string;
  correctionMovementIds: number[];
  idempotent: boolean;
};

export class PrelaunchTestVoidError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PrelaunchTestVoidError";
  }
}

function assertInput(input: PrelaunchTestVoidInput): void {
  const inputKeys = Object.keys(input as object).sort().join(",");
  if (inputKeys !== "actor,idempotencyKey,orderId,tenantId") throw new PrelaunchTestVoidError(422, "Unknown recovery fields are not allowed");
  const actorKeys = Object.keys(input.actor as object).sort();
  if (actorKeys.some(key => !["email", "id", "ipAddress", "role"].includes(key))) throw new PrelaunchTestVoidError(422, "Unknown actor fields are not allowed");
  if (!Number.isInteger(input.tenantId) || input.tenantId <= 0 || !Number.isInteger(input.orderId) || input.orderId <= 0) {
    throw new PrelaunchTestVoidError(422, "A valid tenant and order are required");
  }
  if (!/^prelaunch-test-void-[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey)) {
    throw new PrelaunchTestVoidError(422, "A valid pre-launch recovery idempotency key is required");
  }
  if (!Number.isInteger(input.actor.id) || input.actor.id <= 0 || !["admin", "global_admin"].includes(input.actor.role)) {
    throw new PrelaunchTestVoidError(403, "Admin permission is required for pre-launch test-order recovery");
  }
}

/**
 * Reconciles a synthetic, unpaid order created before the movement ledger.
 * This is deliberately an internal operation; it is not a generic order or
 * inventory repair API. Legacy consumption is represented by an immutable
 * correction movement with unknown cost, never by a fabricated sale/receipt.
 */
export async function voidPrelaunchTestOrder(input: PrelaunchTestVoidInput): Promise<PrelaunchTestVoidResult> {
  assertInput(input);
  return db.transaction(async tx => {
    const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.id, input.orderId), eq(ordersTable.tenantId, input.tenantId))).for("update").limit(1);
    if (!order) throw new PrelaunchTestVoidError(404, "Order not found for this tenant");

    const replayed = await tx.execute(sql`SELECT id FROM audit_logs
      WHERE tenant_id = ${input.tenantId} AND action = 'order.prelaunch_test_void'
        AND resource_id = ${String(input.orderId)}
        AND metadata->>'recoveryId' = ${input.idempotencyKey}
      LIMIT 1`);
    const replayRows = Array.isArray(replayed) ? replayed : ((replayed as { rows?: unknown[] }).rows ?? []);
    if (replayRows.length > 0) {
      return {
        orderId: input.orderId, previousStatus: order.status, finalStatus: "cancelled",
        releasedReservations: 0, reconciledReservations: 0, restoredQuantity: "0", unknownCostQuantity: "0",
        correctionMovementIds: [], idempotent: true,
      };
    }

    const paymentEvidence = await tx.execute(sqlPaymentEvidence(input.tenantId, input.orderId));
    const evidenceRows = Array.isArray(paymentEvidence) ? paymentEvidence : ((paymentEvidence as { rows?: unknown[] }).rows ?? []);
    const evidence = evidenceRows[0] as { captured: string; cash: string; credit: string; paid: string } | undefined;
    if (order.paymentStatus !== "unpaid" || (evidence && [evidence.captured, evidence.cash, evidence.credit, evidence.paid].some(value => Number(value) > 0))) {
      throw new PrelaunchTestVoidError(409, "Payment evidence exists; administrative test-order void is blocked");
    }

    const reservations = await tx.select().from(inventoryReservationsTable)
      .where(eq(inventoryReservationsTable.orderId, input.orderId)).for("update");
    const items = await tx.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, input.orderId));
    const itemByCatalog = new Map(items.map(item => [item.catalogItemId, item]));
    let releasedReservations = 0;
    let reconciledReservations = 0;
    let restoredQuantity = 0;
    const correctionMovementIds: number[] = [];

    for (const reservation of reservations) {
      if (reservation.status === "reserved") {
        await tx.update(inventoryReservationsTable).set({ status: "released", updatedAt: new Date() }).where(eq(inventoryReservationsTable.id, reservation.id));
        releasedReservations += 1;
        continue;
      }
      if (reservation.status === "released" || reservation.status === "reconciled") continue;
      if (reservation.status !== "confirmed") throw new PrelaunchTestVoidError(409, `Reservation ${reservation.id} is inconsistent and requires review`);

      const key = `${input.idempotencyKey}:${reservation.id}`;
      const existing = await tx.execute(sqlExistingCorrection(input.tenantId, key));
      const existingRows = Array.isArray(existing) ? existing : ((existing as { rows?: unknown[] }).rows ?? []);
      if (existingRows.length > 0) {
        await tx.update(inventoryReservationsTable).set({ status: "reconciled", updatedAt: new Date() }).where(eq(inventoryReservationsTable.id, reservation.id));
        reconciledReservations += 1;
        continue;
      }

      // Unknown legacy cost may not be converted into a known value. The
      // ledger's unknown_baseline state accepts this correction with NULL cost.
      const valuation = await tx.execute(sqlValuationStatus(input.tenantId, reservation.catalogItemId));
      const valuationRows = Array.isArray(valuation) ? valuation : ((valuation as { rows?: unknown[] }).rows ?? []);
      const status = (valuationRows[0] as { cost_status?: string } | undefined)?.cost_status;
      if (status === "known") throw new PrelaunchTestVoidError(409, `Legacy cost for item ${reservation.catalogItemId} is not explicitly unknown`);

      const movement = await postInventoryMovement(tx, {
        tenantId: input.tenantId,
        actor: input.actor,
        entityType: "catalog",
        itemId: reservation.catalogItemId,
        locationId: reservation.locationId,
        movementType: "correction",
        direction: "increase",
        quantity: String(reservation.quantity),
        unitCost: null,
        sourceType: "prelaunch_test_order_void",
        sourceId: String(reservation.id),
        orderId: input.orderId,
        orderItemId: itemByCatalog.get(reservation.catalogItemId)?.id ?? null,
        reasonCode: PRELAUNCH_TEST_VOID_REASON,
        reasonText: PRELAUNCH_TEST_VOID_REASON,
        idempotencyKey: key,
        correlationId: input.idempotencyKey,
      });
      correctionMovementIds.push(movement.id);
      restoredQuantity += reservation.quantity;
      await tx.update(inventoryReservationsTable).set({ status: "reconciled", updatedAt: new Date() }).where(eq(inventoryReservationsTable.id, reservation.id));
      reconciledReservations += 1;
    }

    const now = new Date();
    await tx.update(ordersTable).set({ status: "cancelled", fulfillmentStatus: "cancelled", cancelledAt: now, cancelledByUserId: input.actor.id, updatedAt: now }).where(and(eq(ordersTable.id, input.orderId), eq(ordersTable.tenantId, input.tenantId)));
    await tx.insert(auditLogsTable).values({
      tenantId: input.tenantId, actorId: input.actor.id, actorEmail: input.actor.email ?? "", actorRole: input.actor.role,
      action: "order.prelaunch_test_void", resourceType: "order", resourceId: String(input.orderId),
      metadata: { orderId: input.orderId, previousStatus: order.status, reason: PRELAUNCH_TEST_VOID_REASON, releasedReservations, reconciledReservations, restoredQuantity: String(restoredQuantity), unknownCostQuantity: String(restoredQuantity), correctionMovementIds, recoveryId: input.idempotencyKey },
      ipAddress: input.actor.ipAddress ?? null,
    });
    return { orderId: input.orderId, previousStatus: order.status, finalStatus: "cancelled", releasedReservations, reconciledReservations, restoredQuantity: String(restoredQuantity), unknownCostQuantity: String(restoredQuantity), correctionMovementIds, idempotent: false };
  });
}

function sqlPaymentEvidence(tenantId: number, orderId: number) {
  return sql`SELECT
    (SELECT count(*) FROM payment_captures c JOIN payment_attempts a ON a.id = c.payment_attempt_id WHERE c.tenant_id = ${tenantId} AND a.order_id = ${orderId} AND c.state IN ('captured','completed','succeeded')) AS captured,
    (SELECT count(*) FROM cash_ledger_entries WHERE tenant_id = ${tenantId} AND order_id = ${orderId}) AS cash,
    (SELECT count(*) FROM customer_credit_ledger WHERE tenant_id = ${tenantId} AND order_id = ${orderId}) AS credit,
    (SELECT count(*) FROM payment_attempts WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND state IN ('captured','refunded','partially_refunded')) AS paid`;
}

function sqlExistingCorrection(tenantId: number, key: string) {
  return sql`SELECT id FROM inventory_movements WHERE tenant_id = ${tenantId} AND idempotency_key = ${key} AND movement_type = 'correction' LIMIT 1`;
}

function sqlValuationStatus(tenantId: number, catalogItemId: number) {
  return sql`SELECT cost_status FROM inventory_valuation_states WHERE tenant_id = ${tenantId} AND catalog_item_id = ${catalogItemId} FOR UPDATE`;
}
