import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("CSR queue and expo durability guards", () => {
  it("projects customer names from tenant-owned order identities and only queries orders", () => {
    const route = read("artifacts/api-server/src/routes/shift-queue.ts");
    expect(route).toContain("customerName = sql<string>");
    expect(route).toContain("ordersTable.customerNameSnapshot");
    expect(route).toContain("innerJoin(usersTable, and(eq(usersTable.id, ordersTable.customerId), eq(usersTable.tenantId, tenantId)))");
    expect(route).toContain("eq(ordersTable.tenantId, tenantId), activeQueueOrder");
    expect(route).toContain("queue_snapshot_observed");
    expect(route).toContain("creationToFirstQueueSnapshotObservedMedianMs");
    expect(route).toContain("firstQueueObservationAt.size > 50_000");
    expect(route).toContain("queue_snapshot_failed");
  });

  it("creates print recovery work in the order transaction and retries under a lease", () => {
    const notifications = read("artifacts/api-server/src/lib/orderNotifications.ts");
    const worker = read("artifacts/api-server/src/lib/orderPrintOutbox.ts");
    const migration = read("lib/db/drizzle/0080_order_print_outbox.sql");
    expect(notifications).toContain("INSERT INTO order_print_outbox");
    expect(migration).toContain("UNIQUE (tenant_id, order_id)");
    expect(migration).toContain("customer_name_snapshot");
    expect(worker).toContain("FOR UPDATE SKIP LOCKED");
    expect(worker).toContain("attempt_count");
    expect(worker).toContain("startOrderPrintOutboxWorker");
  });

  it("renders the expo ticket from snapshotted variants and SKU data", () => {
    const pipeline = read("artifacts/api-server/src/lib/print/receiptPipeline.ts");
    const documents = read("artifacts/api-server/src/lib/print/documents.ts");
    expect(pipeline).toContain("optionLabel: item.optionLabelSnapshot");
    expect(pipeline).toContain("sku: item.skuSnapshot");
    expect(documents).toContain("SKU: ${item.sku}");
    expect(documents).toContain("function buildExpoTicket");
  });
});
