import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, uberDeliveryFulfillmentsTable, uberDeliveryWebhookEventsTable } from "@workspace/db";
import { hasUberDirectWebhookConfig, verifyUberWebhookSignature } from "../lib/uberDirect";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const terminal = new Set(["delivered", "canceled", "cancelled"]);

function stringAt(value: unknown, max = 160): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

router.post("/webhooks/uber-direct", async (req, res): Promise<void> => {
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  const signature = req.get("x-uber-signature") ?? req.get("x-postmates-signature") ?? undefined;
  if (!raw || raw.length === 0 || raw.length > 262_144 || !hasUberDirectWebhookConfig() || !verifyUberWebhookSignature(raw, signature)) {
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
  const externalReference = stringAt(meta.external_order_id ?? meta.order_id, 160);
  const providerDeliveryId = stringAt(meta.delivery_id ?? data.delivery_id ?? event.delivery_id, 160);
  const providerStatus = stringAt(data.status ?? event.status, 80)?.toLowerCase() ?? null;
  if (!eventId || !eventType) { res.status(400).json({ error: "Invalid webhook event" }); return; }
  const [existing] = await db.select({ id: uberDeliveryWebhookEventsTable.id }).from(uberDeliveryWebhookEventsTable).where(eq(uberDeliveryWebhookEventsTable.providerEventId, eventId)).limit(1);
  if (existing) { res.status(200).json({ received: true, replayed: true }); return; }
  const [fulfillment] = externalReference?.startsWith("myorder-")
    ? await db.select().from(uberDeliveryFulfillmentsTable).where(eq(uberDeliveryFulfillmentsTable.externalOrderReference, externalReference)).limit(1)
    : [];
  const inserted = await db.insert(uberDeliveryWebhookEventsTable).values({
    providerEventId: eventId, eventType, tenantId: fulfillment?.tenantId ?? null,
    fulfillmentId: fulfillment?.id ?? null, providerDeliveryId, providerStatus,
    eventTime: typeof event.event_time === "string" && !Number.isNaN(new Date(event.event_time).getTime()) ? new Date(event.event_time) : null,
    processedAt: new Date(),
  }).onConflictDoNothing().returning({ id: uberDeliveryWebhookEventsTable.id });
  if (!inserted.length) { res.status(200).json({ received: true, replayed: true }); return; }
  if (fulfillment && providerStatus) {
    const currentTerminal = fulfillment.providerStatus && terminal.has(fulfillment.providerStatus.toLowerCase());
    if (!currentTerminal) {
      await db.update(uberDeliveryFulfillmentsTable).set({
        providerDeliveryId: providerDeliveryId ?? fulfillment.providerDeliveryId,
        providerStatus,
        requestState: terminal.has(providerStatus) ? providerStatus : "delivery_created",
        updatedAt: new Date(),
      }).where(and(eq(uberDeliveryFulfillmentsTable.id, fulfillment.id), eq(uberDeliveryFulfillmentsTable.tenantId, fulfillment.tenantId)));
    }
  } else if (!fulfillment) {
    logger.info({ eventType, hasExternalReference: Boolean(externalReference), hasProviderDeliveryId: Boolean(providerDeliveryId) }, "Ignored Uber Direct webhook without a server-owned fulfillment");
  }
  res.status(200).json({ received: true, replayed: false });
});

export default router;
