import { and, eq, sql } from "drizzle-orm";
import { db, ordersTable, uberDeliveryFulfillmentsTable, uberDeliveryQuotesTable, usersTable } from "@workspace/db";
import { cancelUberDelivery, createUberDelivery, getUberDelivery, getUberPickupAction, listUberDeliveries, type UberAddress, type UberManifestItem } from "./uberDirect";
import { nextUberDeliveryStatus } from "./uberDeliveryState";
import { getUberDirectPickupContact, getUberDirectRuntimeConfig, isUberDirectDispatchEnabledForTenant } from "./uberDirectConfig";
import { logger } from "./logger";

// A timed-out create may have succeeded at Uber. Never issue a second create
// until a provider lookup has reconciled the first attempt.
const RETRYABLE = new Set(["delivery_create_pending"]);

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
  if (await isUberDirectDispatchEnabledForTenant(tenantId)) await dispatchPendingUberDelivery(tenantId, orderId);
}

/** A worker/recovery-safe dispatch attempt. It uses the durable unique external reference. */
export async function dispatchPendingUberDelivery(tenantId: number, orderId: number): Promise<void> {
  const [fulfillment] = await db.select().from(uberDeliveryFulfillmentsTable)
    .where(and(eq(uberDeliveryFulfillmentsTable.tenantId, tenantId), eq(uberDeliveryFulfillmentsTable.orderId, orderId))).limit(1);
  if (!fulfillment || fulfillment.providerDeliveryId || !RETRYABLE.has(fulfillment.requestState)) return;
  const [order] = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.id, orderId), eq(ordersTable.paymentStatus, "paid"))).limit(1);
  const [quote] = await db.select().from(uberDeliveryQuotesTable).where(and(eq(uberDeliveryQuotesTable.id, fulfillment.quoteId), eq(uberDeliveryQuotesTable.tenantId, tenantId))).limit(1);
  const [customer] = order ? await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName, phone: usersTable.contactPhone }).from(usersTable).where(eq(usersTable.id, order.customerId)).limit(1) : [];
  const [pickup, config] = await Promise.all([getUberDirectPickupContact(tenantId), getUberDirectRuntimeConfig(tenantId)]);
  const customerName = `${customer?.firstName ?? ""} ${customer?.lastName ?? ""}`.trim();
  if (!order || !quote || !pickup || !config || !customerName || !customer?.phone) {
    await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "configuration_required", lastSanitizedError: "delivery_contact_configuration_required", updatedAt: new Date() })
      .where(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id));
    return;
  }
  if (quote.expiresAt <= new Date()) {
    await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "requote_required", lastSanitizedError: "quote_expired_before_dispatch", updatedAt: new Date() })
      .where(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id));
    await db.update(ordersTable).set({ fulfillmentStatus: "reconciliation_required", updatedAt: new Date() })
      .where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.id, orderId), eq(ordersTable.paymentStatus, "paid")));
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
    }, config);
    await db.update(uberDeliveryFulfillmentsTable).set({ providerDeliveryId: delivery.id, providerStatus: delivery.status ?? "pending", requestState: "delivery_created", lastSanitizedError: null, updatedAt: new Date() })
      .where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.requestState, "creating")));
  } catch (error) {
    await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "reconciliation_required", lastSanitizedError: safeFailure(error), updatedAt: new Date() })
      .where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.requestState, "creating")));
    logger.warn({ tenantId, orderId, failure: safeFailure(error) }, "Uber Direct delivery queued for recovery");
  }
}

/** Bounded provider scan. An absent result never authorizes a second create. */
export async function reconcileUberDelivery(tenantId: number, orderId: number): Promise<string> {
  const [fulfillment] = await db.select().from(uberDeliveryFulfillmentsTable)
    .where(and(eq(uberDeliveryFulfillmentsTable.tenantId, tenantId), eq(uberDeliveryFulfillmentsTable.orderId, orderId))).limit(1);
  if (!fulfillment) return "not_found";
  if (!["creating", "reconciliation_required", "manual_reconciliation_required", "canceling", "cancel_reconciliation_required"].includes(fulfillment.requestState)) return fulfillment.requestState;
  const config = await getUberDirectRuntimeConfig(tenantId);
  if (!config) return "configuration_required";
  if (fulfillment.providerDeliveryId) {
    const delivery = await getUberDelivery(fulfillment.providerDeliveryId, config);
    if (delivery.external_id !== fulfillment.externalOrderReference) return "identity_mismatch";
    const status = nextUberDeliveryStatus(fulfillment.providerStatus, delivery.status ?? "");
    if (status) await db.update(uberDeliveryFulfillmentsTable).set({ providerStatus: status, requestState: ["canceled", "delivered", "returned"].includes(status) ? status : "delivery_created", updatedAt: new Date() })
      .where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.tenantId, tenantId)));
    return status ?? fulfillment.requestState;
  }
  const [quote] = await db.select().from(uberDeliveryQuotesTable).where(and(eq(uberDeliveryQuotesTable.id, fulfillment.quoteId), eq(uberDeliveryQuotesTable.tenantId, tenantId))).limit(1);
  if (!quote) return "quote_missing";
  let offset = 0;
  for (let page = 0; page < 5; page += 1) {
    const batch = await listUberDeliveries(config, 100, offset);
    const matches = batch.deliveries.filter(item => item.external_id === fulfillment.externalOrderReference && item.quote_id === quote.providerQuoteId);
    if (matches.length > 1) return "duplicate_provider_identity";
    if (matches.length === 1) {
      const delivery = matches[0];
      await db.update(uberDeliveryFulfillmentsTable).set({ providerDeliveryId: delivery.id, providerStatus: delivery.status ?? "pending", requestState: "delivery_created", lastSanitizedError: null, updatedAt: new Date() })
        .where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.tenantId, tenantId), sql`${uberDeliveryFulfillmentsTable.providerDeliveryId} IS NULL`));
      return "delivery_created";
    }
    if (!batch.hasMore) break;
    offset += batch.deliveries.length;
  }
  // Provider listing can lag creation. Keep the order visibly unresolved and
  // require an operator to verify before any new request is permitted.
  await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "manual_reconciliation_required", lastSanitizedError: "delivery_not_found_in_bounded_lookup", updatedAt: new Date() })
    .where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.tenantId, tenantId), eq(uberDeliveryFulfillmentsTable.requestState, fulfillment.requestState)));
  await db.update(ordersTable).set({ fulfillmentStatus: "reconciliation_required", updatedAt: new Date() })
    .where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.id, orderId), eq(ordersTable.paymentStatus, "paid")));
  return "manual_reconciliation_required";
}

/** Courier cancellation is separate from payment refund and order cancellation. */
export async function requestUberCancellation(tenantId: number, orderId: number): Promise<string> {
  const [fulfillment] = await db.select().from(uberDeliveryFulfillmentsTable)
    .where(and(eq(uberDeliveryFulfillmentsTable.tenantId, tenantId), eq(uberDeliveryFulfillmentsTable.orderId, orderId))).limit(1);
  if (!fulfillment) return "not_found";
  if (["canceled", "canceling", "cancel_reconciliation_required"].includes(fulfillment.requestState)) return fulfillment.requestState;
  if (!fulfillment.providerDeliveryId || !["pending", "pickup"].includes(fulfillment.providerStatus ?? "")) return "not_cancellable";
  const config = await getUberDirectRuntimeConfig(tenantId);
  if (!config) return "configuration_required";
  const claimed = await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "canceling", updatedAt: new Date() })
    .where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.tenantId, tenantId), eq(uberDeliveryFulfillmentsTable.requestState, "delivery_created"))).returning();
  if (!claimed.length) return "conflict";
  try {
    const delivery = await cancelUberDelivery(fulfillment.providerDeliveryId, config);
    if (delivery.id !== fulfillment.providerDeliveryId) {
      await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "cancel_reconciliation_required", lastSanitizedError: "cancel_identity_mismatch", updatedAt: new Date() })
        .where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.requestState, "canceling")));
      return "cancel_reconciliation_required";
    }
    await db.update(uberDeliveryFulfillmentsTable).set({ providerStatus: delivery.status ?? "canceled", requestState: "canceled", updatedAt: new Date() })
      .where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.requestState, "canceling")));
    await db.update(ordersTable).set({ fulfillmentStatus: "reconciliation_required", updatedAt: new Date() })
      .where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.id, orderId)));
    return "canceled";
  } catch {
    await db.update(uberDeliveryFulfillmentsTable).set({ requestState: "cancel_reconciliation_required", lastSanitizedError: "cancel_ambiguous", updatedAt: new Date() })
      .where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.requestState, "canceling")));
    return "cancel_reconciliation_required";
  }
}
