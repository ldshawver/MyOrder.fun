import { and, eq, sql } from "drizzle-orm";
import { db, ordersTable, uberDeliveryFulfillmentsTable, uberDeliveryQuotesTable, usersTable } from "@workspace/db";
import { createUberDelivery, getUberPickupContact, getUberPickupAction, isUberDirectDispatchEnabled, type UberAddress, type UberManifestItem } from "./uberDirect";
import { logger } from "./logger";

const RETRYABLE = new Set(["delivery_create_pending", "retry_pending"]);

function safeFailure(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return `provider:${(error as { code: string }).code.slice(0, 80)}`;
  return "provider:delivery_creation_failed";
}

/**
 * Durable handoff after a paid local-delivery order. It deliberately does not
 * call Uber unless dispatch has been explicitly enabled in server-only config.
 */
export async function queueUberDeliveryForPaidOrder(tenantId: number, orderId: number): Promise<void> {
  const [order] = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.id, orderId))).limit(1);
  if (!order || order.paymentStatus !== "paid" || order.deliveryMethod !== "uber_direct" || !order.deliveryQuoteId) return;
  const [quote] = await db.select().from(uberDeliveryQuotesTable).where(and(eq(uberDeliveryQuotesTable.id, order.deliveryQuoteId), eq(uberDeliveryQuotesTable.tenantId, tenantId))).limit(1);
  if (!quote) {
    logger.error({ tenantId, orderId }, "Paid Uber delivery order has no server-owned quote");
    return;
  }
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}, ${orderId})`);
    await tx.insert(uberDeliveryFulfillmentsTable).values({
      tenantId, orderId, quoteId: quote.id,
      externalOrderReference: `myorder-${tenantId}-${orderId}`,
      requestState: "delivery_create_pending",
    }).onConflictDoNothing();
    await tx.update(uberDeliveryFulfillmentsTable).set({ requestState: "delivery_create_pending", updatedAt: new Date() })
      .where(and(eq(uberDeliveryFulfillmentsTable.tenantId, tenantId), eq(uberDeliveryFulfillmentsTable.orderId, orderId), eq(uberDeliveryFulfillmentsTable.requestState, "payment_pending")));
    await tx.update(uberDeliveryQuotesTable).set({ status: "consumed", consumedAt: new Date() })
      .where(and(eq(uberDeliveryQuotesTable.id, quote.id), eq(uberDeliveryQuotesTable.status, "quoted")));
  });
  if (isUberDirectDispatchEnabled()) await dispatchPendingUberDelivery(tenantId, orderId);
}

/** A worker/recovery-safe dispatch attempt. It uses the durable unique external reference. */
export async function dispatchPendingUberDelivery(tenantId: number, orderId: number): Promise<void> {
  const [fulfillment] = await db.select().from(uberDeliveryFulfillmentsTable)
    .where(and(eq(uberDeliveryFulfillmentsTable.tenantId, tenantId), eq(uberDeliveryFulfillmentsTable.orderId, orderId))).limit(1);
  if (!fulfillment || fulfillment.providerDeliveryId || !RETRYABLE.has(fulfillment.requestState)) return;
  const [order] = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.id, orderId), eq(ordersTable.paymentStatus, "paid"))).limit(1);
  const [quote] = await db.select().from(uberDeliveryQuotesTable).where(and(eq(uberDeliveryQuotesTable.id, fulfillment.quoteId), eq(uberDeliveryQuotesTable.tenantId, tenantId))).limit(1);
  const [customer] = order ? await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName, phone: usersTable.contactPhone }).from(usersTable).where(eq(usersTable.id, order.customerId)).limit(1) : [];
  const pickup = getUberPickupContact();
  const customerName = `${customer?.firstName ?? ""} ${customer?.lastName ?? ""}`.trim();
  if (!order || !quote || !pickup || !customerName || !customer?.phone) {
    await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "configuration_required", lastSanitizedError: "delivery_contact_configuration_required", updatedAt: new Date() })
      .where(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id));
    return;
  }
  const claimed = await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "creating", attemptCount: fulfillment.attemptCount + 1, lastAttemptAt: new Date(), updatedAt: new Date() })
    .where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.requestState, fulfillment.requestState))).returning();
  if (!claimed.length) return;
  try {
    const delivery = await createUberDelivery({
      quoteId: quote.providerQuoteId, externalOrderReference: fulfillment.externalOrderReference,
      pickupAddress: quote.pickupAddress as UberAddress, pickupName: pickup.name, pickupPhoneNumber: pickup.phone,
      dropoffAddress: quote.dropoffAddress as UberAddress, dropoffName: customerName, dropoffPhoneNumber: customer.phone,
      manifestItems: quote.manifestItems as UberManifestItem[], pickupAction: getUberPickupAction(),
    });
    await db.update(uberDeliveryFulfillmentsTable).set({ providerDeliveryId: delivery.id, providerStatus: delivery.status ?? "created", requestState: "delivery_created", lastSanitizedError: null, updatedAt: new Date() })
      .where(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id));
  } catch (error) {
    await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "retry_pending", lastSanitizedError: safeFailure(error), updatedAt: new Date() })
      .where(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id));
    logger.warn({ tenantId, orderId, failure: safeFailure(error) }, "Uber Direct delivery queued for recovery");
  }
}
