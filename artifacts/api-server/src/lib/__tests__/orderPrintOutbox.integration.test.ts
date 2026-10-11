import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../printService", async importOriginal => {
  const actual = await importOriginal<typeof import("../printService")>();
  return { ...actual, enqueueOrderPrintJobs: vi.fn() };
});

import { sql } from "drizzle-orm";
import {
  catalogItemsTable,
  db,
  orderItemsTable,
  ordersTable,
  pool,
  printBridgeProfilesTable,
  printJobsTable,
  printPrintersTable,
  printRoutesTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { enqueueOrderCreated } from "../orderNotifications";
import { enqueueOrderPrintJobs } from "../printService";
import { processOrderPrintOutboxOnce } from "../orderPrintOutbox";
import { queueDocumentPrint } from "../print/documentJobs";
import { loadReceiptData } from "../print/receiptPipeline";
import { buildExpoTicket } from "../print/documents";

const enabled = process.env.RUN_ORDER_PRINT_OUTBOX_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;
const mockedEnqueue = vi.mocked(enqueueOrderPrintJobs);

suite("order print outbox PostgreSQL recovery", () => {
  let tenantId = 0;
  let customerId = 0;
  let catalogItemId = 0;
  let orderId = 0;
  let printerId = 0;
  let bridgeId = 0;

  beforeAll(async () => {
    if (!/^postgresql:\/\/[^@]+@(?:127\.0\.0\.1|localhost):\d{4,5}\/myorder_print_outbox_validation$/.test(process.env.DATABASE_URL ?? "")
      || process.env.TEST_DISPOSABLE_CLONE !== "I_UNDERSTAND_THIS_CLONE_IS_TRUNCATED") {
      throw new Error("Explicit isolated print-outbox validation database required");
    }
    await db.execute(sql`TRUNCATE TABLE ${tenantsTable} RESTART IDENTITY CASCADE`);
    const [tenant] = await db.insert(tenantsTable).values({ name: "Print Outbox Test", slug: "print-outbox-test", status: "active" }).returning();
    tenantId = tenant!.id;
    const [bridge] = await db.insert(printBridgeProfilesTable).values({
      tenantId, name: "Offline test bridge", bridgeUrl: "http://127.0.0.1:1", isActive: true,
    }).returning();
    bridgeId = bridge!.id;
    const [printer] = await db.insert(printPrintersTable).values({
      tenantId, name: "Offline test expo printer", role: "kitchen", bridgeProfileId: bridgeId,
      bridgeUrl: "http://127.0.0.1:1", isActive: true,
    }).returning();
    printerId = printer!.id;
    await db.insert(printRoutesTable).values({
      tenantId, jobType: "EXPO", bridgeProfileId: bridgeId, printerId, isActive: true,
    });
    const [customer] = await db.insert(usersTable).values({
      clerkId: "print_outbox_customer", email: "print-outbox@example.test", normalizedEmail: "print-outbox@example.test",
      firstName: "Print", lastName: "Customer", role: "user", tenantId, status: "approved",
      identityStatus: "verified", provisioningStatus: "active",
    }).returning();
    customerId = customer!.id;
    const [item] = await db.insert(catalogItemsTable).values({
      tenantId, name: "Oil", category: "Fixture", price: "8.00", sku: "OIL-PARENT",
      isAvailable: true, isTaxable: true,
    }).returning();
    catalogItemId = item!.id;
    const [order] = await db.insert(ordersTable).values({
      tenantId, customerId, customerNameSnapshot: "Print Customer", status: "submitted",
      paymentStatus: "unpaid", paymentMethod: "cash", subtotal: "24.00", tax: "0.00", total: "24.00",
      deliveryMethod: "pickup", notes: "Keep upright", orderType: "ONLINE",
    }).returning();
    orderId = order!.id;
    await db.insert(orderItemsTable).values([
      { orderId, catalogItemId, catalogItemName: "Oil", optionLabelSnapshot: "4 oz", variantSnapshot: { size: "4 oz" }, skuSnapshot: "OIL-4OZ", quantity: 2, unitPrice: "8.00", totalPrice: "16.00" },
      { orderId, catalogItemId, catalogItemName: "Oil", optionLabelSnapshot: "8 oz", variantSnapshot: { size: "8 oz" }, skuSnapshot: "OIL-8OZ", quantity: 1, unitPrice: "8.00", totalPrice: "8.00" },
    ]);
  }, 30_000);

  afterAll(async () => { await pool.end(); });

  it("recovers a crashed lease and enqueues one consolidated snapshot idempotently", async () => {
    mockedEnqueue.mockReset().mockResolvedValue(undefined);
    await enqueueOrderCreated(db, tenantId, orderId, new Date());
    await enqueueOrderCreated(db, tenantId, orderId, new Date());
    const created = await db.execute(sql`SELECT count(*)::int AS count FROM order_print_outbox WHERE tenant_id=${tenantId} AND order_id=${orderId}`);
    const events = await db.execute(sql`SELECT count(*)::int AS count FROM order_notification_events WHERE tenant_id=${tenantId} AND order_id=${orderId} AND event_type='ORDER_CREATED'`);
    expect(created.rows[0]?.count).toBe(1);
    expect(events.rows[0]?.count).toBe(1);

    await db.execute(sql`UPDATE order_print_outbox SET state='processing',attempt_count=1,claimed_at=now()-interval '2 minutes',lease_owner='crashed-worker' WHERE tenant_id=${tenantId} AND order_id=${orderId}`);
    expect(await processOrderPrintOutboxOnce()).toBe(true);
    const [row] = (await db.execute(sql`SELECT state,attempt_count,lease_owner FROM order_print_outbox WHERE tenant_id=${tenantId} AND order_id=${orderId}`)).rows as Array<{ state: string; attempt_count: number; lease_owner: string | null }>;
    expect(row).toMatchObject({ state: "completed", attempt_count: 2, lease_owner: null });
    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
    const payload = mockedEnqueue.mock.calls[0]![0];
    expect(payload.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ quantity: 2, optionLabelSnapshot: "4 oz", skuSnapshot: "OIL-4OZ", variantSnapshot: { size: "4 oz" } }),
      expect.objectContaining({ quantity: 1, optionLabelSnapshot: "8 oz", skuSnapshot: "OIL-8OZ", variantSnapshot: { size: "8 oz" } }),
    ]));
    expect(payload.notes).toBe("Keep upright");
    const receiptData = await loadReceiptData(tenantId, orderId);
    const expoLines = buildExpoTicket(receiptData!);
    const expoText = expoLines.map(line => line.text).join("\n");
    expect(expoText).toContain("2 x Oil");
    expect(expoText).toContain("4 oz");
    expect(expoText).toContain("OIL-4OZ");
    expect(expoText).toContain("1 x Oil");
    expect(expoText).toContain("8 oz");
    expect(expoText).toContain("OIL-8OZ");
    expect(expoText).toContain("Keep upright");

    const printInput = {
      tenantId, locationId: null, orderId, documentType: "EXPO" as const, jobType: "expo_ticket",
      idempotencyKey: `expo_ticket:${tenantId}:${orderId}`,
      render: { kind: "thermal-text" as const, text: async () => ({ text: expoText }) },
    };
    const queued = await queueDocumentPrint(printInput);
    const repeated = await queueDocumentPrint(printInput);
    expect(queued.status).toBe("queued");
    expect(repeated.status).toBe("duplicate");
    if (queued.status !== "queued" || repeated.status !== "duplicate") throw new Error("print queue failed to return idempotent result");
    expect(repeated.job.id).toBe(queued.job.id);
    const printJobCount = await db.execute(sql`SELECT count(*)::int AS count FROM ${printJobsTable} WHERE tenant_id=${tenantId} AND idempotency_key=${printInput.idempotencyKey}`);
    expect(printJobCount.rows[0]?.count).toBe(1);
    expect(await processOrderPrintOutboxOnce()).toBe(false);
    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
  });

  it("keeps retryable failures visible, retries safely, and bounds terminal failures", async () => {
    const [retryOrder] = await db.insert(ordersTable).values({ tenantId, customerId, status: "submitted", paymentStatus: "unpaid", subtotal: "1.00", tax: "0.00", total: "1.00", orderType: "ONLINE" }).returning();
    await enqueueOrderCreated(db, tenantId, retryOrder!.id, new Date());
    mockedEnqueue.mockReset().mockRejectedValueOnce(new Error("bridge_unavailable"));
    expect(await processOrderPrintOutboxOnce()).toBe(true);
    const [retry] = (await db.execute(sql`SELECT state,attempt_count,last_error_code,next_attempt_at>now() AS delayed FROM order_print_outbox WHERE tenant_id=${tenantId} AND order_id=${retryOrder!.id}`)).rows as Array<{ state: string; attempt_count: number; last_error_code: string; delayed: boolean }>;
    expect(retry).toMatchObject({ state: "pending", attempt_count: 1, last_error_code: "bridge_unavailable", delayed: true });
    await db.execute(sql`UPDATE order_print_outbox SET next_attempt_at=now() WHERE tenant_id=${tenantId} AND order_id=${retryOrder!.id}`);
    mockedEnqueue.mockResolvedValue(undefined);
    expect(await processOrderPrintOutboxOnce()).toBe(true);
    const completed = await db.execute(sql`SELECT state,attempt_count FROM order_print_outbox WHERE tenant_id=${tenantId} AND order_id=${retryOrder!.id}`);
    expect(completed.rows[0]).toMatchObject({ state: "completed", attempt_count: 2 });

    const [failedOrder] = await db.insert(ordersTable).values({ tenantId, customerId, status: "submitted", paymentStatus: "unpaid", subtotal: "1.00", tax: "0.00", total: "1.00", orderType: "ONLINE" }).returning();
    await enqueueOrderCreated(db, tenantId, failedOrder!.id, new Date());
    await db.execute(sql`UPDATE order_print_outbox SET state='processing',attempt_count=7,claimed_at=now()-interval '2 minutes',lease_owner='crashed-worker' WHERE tenant_id=${tenantId} AND order_id=${failedOrder!.id}`);
    mockedEnqueue.mockReset().mockRejectedValue(new Error("bridge_unavailable"));
    expect(await processOrderPrintOutboxOnce()).toBe(true);
    const [failed] = (await db.execute(sql`SELECT state,attempt_count,last_error_code FROM order_print_outbox WHERE tenant_id=${tenantId} AND order_id=${failedOrder!.id}`)).rows as Array<{ state: string; attempt_count: number; last_error_code: string }>;
    expect(failed).toMatchObject({ state: "failed", attempt_count: 8, last_error_code: "bridge_unavailable" });
  });
});
