import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, ordersTable, uberDeliveryFulfillmentsTable, uberDeliveryWebhookEventsTable } from "@workspace/db";
import { verifyUberWebhookSignatureForTenant } from "../lib/uberDirectConfig";
import { nextUberDeliveryStatus } from "../lib/uberDeliveryState";

const router: IRouter = Router();
const terminal = new Set(["delivered", "canceled", "returned", "failed"]);

function stringAt(value: unknown, max = 160): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

router.post("/webhooks/uber-direct", async (req, res): Promise<void> => {
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  const signature = req.get("x-uber-signature") ?? req.get("x-postmates-signature") ?? undefined;
  if (!raw || raw.length === 0 || raw.length > 262_144) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }
  let event: Record<string, unknown>;
  try { event = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; }
  catch { res.status(400).json({ error: "Invalid webhook body" }); return; }
  const meta = event.meta && typeof event.meta === "object" ? event.meta as Record<string, unknown> : {};
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  const eventId = stringAt(event.event_id ?? event.id, 200);
  const eventType = stringAt(event.event_type, 120);
  const externalReference = stringAt(data.external_id ?? meta.external_order_id ?? meta.order_id, 160);
  const providerDeliveryId = stringAt(data.id ?? meta.delivery_id ?? data.delivery_id ?? event.delivery_id, 160);
  const providerStatus = stringAt(data.status ?? event.status, 80)?.toLowerCase() ?? null;
  if (!eventId || !eventType || !providerDeliveryId || eventType !== "event.delivery_status") { res.status(400).json({ error: "Invalid webhook event" }); return; }
  const [fulfillment] = externalReference?.startsWith("myorder-")
    ? await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.externalOrderReference, externalReference)).limit(1)
    : [];
  if (!fulfillment || !await verifyUberWebhookSignatureForTenant(fulfillment.tenantId, raw, signature)) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }
  if (fulfillment.providerDeliveryId && fulfillment.providerDeliveryId !== providerDeliveryId) {
    res.status(409).json({ error: "Delivery identity mismatch" });
    return;
  }
  const replayed = await db.transaction(async tx => {
    const [current] = await tx.select().from(uberDeliveryFulfillmentsTable)
      .where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.tenantId, fulfillment.tenantId)))
      .for("update").limit(1);
    if (!current || (current.providerDeliveryId && current.providerDeliveryId !== providerDeliveryId)) return true;
    const inserted = await tx.insert(uberDeliveryWebhookEventsTable).values({
      providerEventId: eventId, eventType, tenantId: current.tenantId,
      fulfillmentId: current.id, providerDeliveryId, providerStatus,
      eventTime: typeof event.event_time === "string" && !Number.isNaN(new Date(event.event_time).getTime()) ? new Date(event.event_time) : null,
      processedAt: new Date(),
    }).onConflictDoNothing().returning({ id: uberDeliveryWebhookEventsTable.id });
    if (!inserted.length) return true;
    if (providerStatus) {
      const nextStatus = nextUberDeliveryStatus(current.providerStatus, providerStatus);
      if (nextStatus) await tx.update(uberDeliveryFulfillmentsTable).set({
        providerDeliveryId,
        providerStatus: nextStatus,
        requestState: terminal.has(nextStatus) ? nextStatus
          : ["canceling", "cancel_reconciliation_required"].includes(current.requestState) ? current.requestState : "delivery_created",
        updatedAt: new Date(),
      }).where(and(eq(uberDeliveryFulfillmentsTable.id, current.id), eq(uberDeliveryFulfillmentsTable.tenantId, current.tenantId)));
      if (nextStatus && ["canceled", "returned", "failed"].includes(nextStatus)) await tx.update(ordersTable)
        .set({ fulfillmentStatus: "reconciliation_required", updatedAt: new Date() })
        .where(and(eq(ordersTable.id, current.orderId), eq(ordersTable.tenantId, current.tenantId)));
    }
    return false;
  });
  res.status(200).json({ received: true, replayed });
});

export default router;
