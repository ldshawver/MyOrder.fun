import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  auditLogsTable,
  cashLedgerEntriesTable,
  csrBoxesTable,
  generalQueueCashSessionParticipantsTable,
  generalQueueCashSessionsTable,
  inventoryLocationsTable,
  labTechShiftsTable,
  ordersTable,
  type db,
} from "@workspace/db";
import { consumeCustomerCredit, CustomerCreditError } from "../payments/customerCredit";
import { deductPaidOrderInventory } from "../payments/inventory";
import { requireOrderCatalogForSale, OrderCatalogUnavailableError } from "./orderCatalogEligibility";
import { usesGeneralQueueCashSession } from "./cashCloseoutContext";
import { isShiftOrderRoutable } from "./orderRouting";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CashSettlementActor = { id: number; email: string | null; role: string };
export type CashSettlementInput = {
  tenantId: number;
  orderId: number;
  actor: CashSettlementActor;
  amountTendered: string | number;
  idempotencyKey: string;
  internalNote?: string;
  supervisorOverride: boolean;
  ipAddress?: string;
};

export type CashSettlementOutcome =
  | { status: number; error: string }
  | { status: 200; updated: typeof ordersTable.$inferSelect; ledger: typeof cashLedgerEntriesTable.$inferSelect; idempotent: boolean };

function moneyToCents(value: string | number): number | null {
  const text = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Settles a previously-created cash order inside the caller's transaction.
 * It deliberately owns no transaction boundary: guest capability consumption,
 * order creation, reservations, payment state, and the cash ledger can all
 * commit or roll back together.
 */
export async function settleCashOrder(tx: Transaction, input: CashSettlementInput): Promise<CashSettlementOutcome> {
  const { tenantId, orderId, actor } = input;
  await tx.execute(sql`select pg_advisory_xact_lock(${tenantId}, ${orderId})`);
  const [order] = await tx.select().from(ordersTable).where(and(eq(ordersTable.id, orderId), eq(ordersTable.tenantId, tenantId))).for("update").limit(1);
  if (!order) return { status: 404, error: "Order not found" };
  const [existingLedger] = await tx.select().from(cashLedgerEntriesTable).where(and(eq(cashLedgerEntriesTable.tenantId, tenantId), eq(cashLedgerEntriesTable.idempotencyKey, input.idempotencyKey))).limit(1);
  if (existingLedger) {
    if (existingLedger.orderId !== orderId) return { status: 409, error: "Idempotency key is already in use" };
    if (existingLedger.actorUserId !== actor.id && !input.supervisorOverride) return { status: 403, error: "Only the original cash actor or an authorized supervisor may replay this closeout" };
    return { status: 200, updated: order, ledger: existingLedger, idempotent: true };
  }
  const terminal = ["completed", "refunded", "cancelled", "archived", "voided", "closed"].includes(order.status);
  if (terminal || order.paymentStatus === "paid") return { status: 409, error: "Order is already paid or is not eligible for cash closeout" };
  if (Number((order.taxSnapshot as { schemaVersion?: unknown } | null)?.schemaVersion) >= 3 && order.selectedPaymentMethod !== "cash") return { status: 409, error: "Order was not confirmed for Cash tender" };
  if (order.paymentStatus !== "unpaid" || order.paymentIntentId) return { status: 409, error: "Another payment is pending or associated with this order" };
  const dueCents = moneyToCents(order.remainingTenderAmount ?? order.total);
  const tenderedCents = moneyToCents(input.amountTendered);
  if (dueCents == null || tenderedCents == null) return { status: 422, error: "Invalid authoritative order balance or tender" };
  if (tenderedCents < dueCents) return { status: 422, error: "Amount tendered is insufficient" };
  const changeCents = tenderedCents - dueCents;

  let shift: typeof labTechShiftsTable.$inferSelect | null = null;
  let session: typeof generalQueueCashSessionsTable.$inferSelect | null = null;
  let boxSlug: string;
  let locationId: number | null;
  const assignedToActor = order.assignedCsrUserId === actor.id;
  const openSessions = await tx.select().from(generalQueueCashSessionsTable).where(and(eq(generalQueueCashSessionsTable.tenantId, tenantId), eq(generalQueueCashSessionsTable.status, "open"))).orderBy(desc(generalQueueCashSessionsTable.openedAt)).limit(2);
  const useGeneralQueueSession = usesGeneralQueueCashSession(order.routeSource, openSessions.length);
  if (useGeneralQueueSession && openSessions.length > 1) return { status: 409, error: "Multiple General Queue cash sessions are active; resolve the location configuration before accepting cash" };
  if (useGeneralQueueSession) {
    [session] = openSessions;
    if (!session || (!assignedToActor && !input.supervisorOverride)) return { status: 403, error: "Claim this General Queue order before accepting cash" };
    const [participant] = await tx.select().from(generalQueueCashSessionParticipantsTable).where(and(eq(generalQueueCashSessionParticipantsTable.tenantId, tenantId), eq(generalQueueCashSessionParticipantsTable.sessionId, session.id), eq(generalQueueCashSessionParticipantsTable.userId, actor.id), isNull(generalQueueCashSessionParticipantsTable.leftAt))).limit(1);
    if (!participant) return { status: 403, error: "Join the active General Queue cash session before accepting cash" };
    const [box] = session.registerBoxId == null ? [] : await tx.select().from(csrBoxesTable).where(and(eq(csrBoxesTable.id, session.registerBoxId), eq(csrBoxesTable.tenantId, tenantId), eq(csrBoxesTable.isActive, true))).limit(1);
    if (session.registerBoxId != null && !box) return { status: 409, error: "The General Queue register is unavailable" };
    boxSlug = box?.slug ?? `general-queue-location-${session.locationId}`;
    locationId = session.locationId;
  } else {
    [shift] = await tx.select().from(labTechShiftsTable).where(and(eq(labTechShiftsTable.techId, actor.id), eq(labTechShiftsTable.tenantId, tenantId), eq(labTechShiftsTable.status, "active"))).orderBy(desc(labTechShiftsTable.clockedInAt)).limit(1);
    if (!shift || !isShiftOrderRoutable({ ...shift, expectedTenantId: tenantId })) return { status: 409, error: "Check out an active CSR box before accepting cash" };
    if (!assignedToActor && !input.supervisorOverride) return { status: 403, error: "Only the assigned CSR may close this order for cash" };
    if (order.assignedShiftId != null && order.assignedShiftId !== shift.id) return { status: 403, error: "This order belongs to another CSR box" };
    boxSlug = shift.boxAssignmentId ?? "";
    if (!boxSlug) return { status: 409, error: "The active CSR shift has no authorized register" };
    const [box] = await tx.select().from(csrBoxesTable).where(and(eq(csrBoxesTable.tenantId, tenantId), eq(csrBoxesTable.slug, boxSlug), eq(csrBoxesTable.isActive, true))).limit(1);
    if (!box) return { status: 409, error: "The active CSR register is unavailable" };
    const [location] = await tx.select().from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.csrBoxId, box.id), eq(inventoryLocationsTable.isActive, true))).limit(1);
    locationId = location?.id ?? null;
  }
  try { await requireOrderCatalogForSale(tx, order); } catch (error) { if (error instanceof OrderCatalogUnavailableError) return { status: 409, error: error.message }; throw error; }
  const now = new Date();
  const creditCents = moneyToCents(order.customerCreditApplied) ?? 0;
  if (creditCents > 0) {
    if (order.customerId == null) return { status: 409, error: "Guest orders cannot use customer credit" };
    await consumeCustomerCredit(tx, { tenantId, customerId: order.customerId, actorUserId: actor.id, orderId, amountCents: creditCents, idempotencyKey: `consume:cash:${input.idempotencyKey}` });
  }
  const [updated] = await tx.update(ordersTable).set({ paymentStatus: "paid", paymentMethod: creditCents > 0 ? "customer_credit+cash" : "cash", selectedPaymentMethod: "cash", amountTendered: (tenderedCents / 100).toFixed(2), changeGiven: (changeCents / 100).toFixed(2), remainingTenderAmount: (dueCents / 100).toFixed(2), paymentToken: null, status: order.deliveryMethod === "uber_direct" ? "confirmed" : "completed", fulfillmentStatus: order.deliveryMethod === "uber_direct" ? "submitted" : "completed", completedAt: order.deliveryMethod === "uber_direct" ? null : now, completedByUserId: order.deliveryMethod === "uber_direct" ? null : actor.id, routingStatus: "closed" }).where(and(eq(ordersTable.id, orderId), eq(ordersTable.tenantId, tenantId), eq(ordersTable.paymentStatus, "unpaid"))).returning();
  if (!updated) return { status: 409, error: "A concurrent closeout already completed this order" };
  await deductPaidOrderInventory(updated, { actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, ipAddress: input.ipAddress }, tx);
  const [ledger] = await tx.insert(cashLedgerEntriesTable).values({ tenantId, orderId, shiftId: shift?.id ?? null, generalQueueSessionId: session?.id ?? null, csrUserId: actor.id, actorUserId: actor.id, locationId, boxAssignmentId: boxSlug, amount: (dueCents / 100).toFixed(2), amountTendered: (tenderedCents / 100).toFixed(2), changeGiven: (changeCents / 100).toFixed(2), internalNote: input.internalNote || null, entryType: "cash_sale_closeout", idempotencyKey: input.idempotencyKey }).returning();
  if (shift) await tx.update(labTechShiftsTable).set({ paymentTotalsJson: sql`jsonb_set(coalesce(${labTechShiftsTable.paymentTotalsJson}::jsonb, '{}'::jsonb), '{cash}', to_jsonb(coalesce((${labTechShiftsTable.paymentTotalsJson}->>'cash')::numeric, 0) + ${(dueCents / 100).toFixed(2)}::numeric))::json` }).where(eq(labTechShiftsTable.id, shift.id));
  else if (session) await tx.update(generalQueueCashSessionsTable).set({ paymentTotalsJson: sql`jsonb_set(coalesce(${generalQueueCashSessionsTable.paymentTotalsJson}::jsonb, '{}'::jsonb), '{cash}', to_jsonb(coalesce((${generalQueueCashSessionsTable.paymentTotalsJson}->>'cash')::numeric, 0) + ${(dueCents / 100).toFixed(2)}::numeric))::json` }).where(eq(generalQueueCashSessionsTable.id, session.id));
  await tx.insert(auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "CASH_CLOSEOUT_COMPLETED", resourceType: "order", resourceId: String(orderId), metadata: { paymentMethod: "cash", amount: (dueCents / 100).toFixed(2), amountTendered: (tenderedCents / 100).toFixed(2), changeGiven: (changeCents / 100).toFixed(2), cashLedgerId: ledger.id, shiftId: shift?.id ?? null, generalQueueSessionId: session?.id ?? null, locationId, register: boxSlug, supervisorOverride: input.supervisorOverride }, ipAddress: input.ipAddress ?? null });
  if (input.supervisorOverride) await tx.insert(auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "CASH_CLOSEOUT_SUPERVISOR_OVERRIDE", resourceType: "order", resourceId: String(orderId), metadata: { cashLedgerId: ledger.id, shiftId: shift?.id ?? null, generalQueueCashSessionId: session?.id ?? null }, ipAddress: input.ipAddress ?? null });
  return { status: 200, updated, ledger, idempotent: false };
}

export { CustomerCreditError };
