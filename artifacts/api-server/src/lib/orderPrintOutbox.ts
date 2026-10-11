import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, ordersTable, orderItemsTable, usersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { enqueueOrderPrintJobs } from "./printService";

const POLL_MS = 2_000;
const MAX_ATTEMPTS = 8;
const LEASE_MS = 90_000;

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

type OutboxRow = { id: string; tenant_id: number; order_id: number };

async function claimOne(owner: string): Promise<OutboxRow | null> {
  const result = await db.execute(sql`WITH candidate AS (
    SELECT id FROM order_print_outbox
    WHERE ((state='pending' AND next_attempt_at<=now()) OR (state='processing' AND claimed_at < now() - (${LEASE_MS} * interval '1 millisecond')))
      AND attempt_count < ${MAX_ATTEMPTS}
    ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE order_print_outbox o SET state='processing',attempt_count=o.attempt_count+1,claimed_at=now(),lease_owner=${owner},updated_at=now()
    FROM candidate WHERE o.id=candidate.id RETURNING o.id,o.tenant_id,o.order_id`);
  return rows<OutboxRow>(result)[0] ?? null;
}

export async function processOrderPrintOutboxOnce(): Promise<boolean> {
  const owner = randomUUID();
  const job = await claimOne(owner);
  if (!job) return false;
  try {
    const [order] = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, job.tenant_id), eq(ordersTable.id, job.order_id))).limit(1);
    if (!order) throw new Error("order_missing");
    const [customer] = await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
      .from(usersTable).where(and(eq(usersTable.id, order.customerId), eq(usersTable.tenantId, job.tenant_id))).limit(1);
    const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
    const customerName = order.customerNameSnapshot || [customer?.firstName, customer?.lastName].filter(Boolean).join(" ") || "Customer";
    await enqueueOrderPrintJobs({
      id: order.id,
      tenantId: order.tenantId,
      status: order.status,
      paymentStatus: order.paymentStatus,
      notes: order.notes,
      subtotal: String(order.subtotal),
      tax: String(order.tax),
      total: String(order.total),
      createdAt: order.createdAt,
      customerName,
      customerFirstName: customer?.firstName,
      fulfillmentType: order.deliveryMethod === "uber_direct" ? "Uber Direct delivery" : order.deliveryMethod === "pickup" ? "Pickup" : "Delivery",
      shippingAddress: order.shippingAddress,
      assignedShiftId: order.assignedShiftId,
      items: items.map(item => ({
        quantity: item.quantity,
        catalogItemName: item.catalogItemName,
        optionLabelSnapshot: item.optionLabelSnapshot,
        skuSnapshot: item.skuSnapshot,
        variantSnapshot: item.variantSnapshot as Record<string, unknown> | null,
        unitPrice: String(item.unitPrice),
        totalPrice: String(item.totalPrice),
        alavontName: item.alavontName,
        luciferCruzName: item.luciferCruzName,
      })),
    });
    await db.execute(sql`UPDATE order_print_outbox SET state='completed',claimed_at=NULL,lease_owner=NULL,last_error_code=NULL,updated_at=now()
      WHERE id=${job.id} AND state='processing' AND lease_owner=${owner}`);
  } catch (error) {
    const code = error instanceof Error && /^[a-zA-Z0-9_-]{1,64}$/.test(error.message) ? error.message : "print_enqueue_failed";
    await db.execute(sql`UPDATE order_print_outbox SET
      state=CASE WHEN attempt_count >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
      next_attempt_at=now() + LEAST(power(2, attempt_count)::integer,300) * interval '1 second',
      claimed_at=NULL,lease_owner=NULL,last_error_code=${code},updated_at=now()
      WHERE id=${job.id} AND state='processing' AND lease_owner=${owner}`);
    logger.warn({ event: "order_print_outbox_attempt_failed", tenantId: job.tenant_id, orderId: job.order_id, errorCode: code }, "Order print scheduling attempt failed");
  }
  return true;
}

export function startOrderPrintOutboxWorker(): void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await db.execute(sql`UPDATE order_print_outbox SET state='failed',lease_owner=NULL,claimed_at=NULL,last_error_code='retry_limit_reached',updated_at=now()
        WHERE state='processing' AND attempt_count >= ${MAX_ATTEMPTS} AND claimed_at < now() - (${LEASE_MS} * interval '1 millisecond')`);
      while (await processOrderPrintOutboxOnce()) { /* drain available durable jobs */ }
    } catch (error) {
      logger.warn({ event: "order_print_outbox_worker_failed", errorName: error instanceof Error ? error.name : "unknown" }, "Order print worker tick failed");
    } finally { running = false; }
  }, POLL_MS);
  timer.unref();
}
