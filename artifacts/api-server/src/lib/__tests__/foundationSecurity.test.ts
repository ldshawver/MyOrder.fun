import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (relative: string) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");

describe("tenant-owned authority boundaries", () => {
  it("scopes catalog display reads and writes before mutation", () => {
    const catalog = source("routes/catalog.ts");
    const display = catalog.slice(catalog.indexOf('router.patch("/catalog/:id/display"'), catalog.indexOf('// GET /api/catalog/:id'));
    expect(display.match(/eq\(catalogItemsTable\.tenantId, req\.authorizedTenantId!\)/g)?.length).toBe(2);
    expect(display).not.toContain("where(eq(catalogItemsTable.id, id))");
  });
  it("scopes order lookups and journal replay by tenant", () => {
    const orders = source("routes/orders.ts");
    const notes = orders.slice(orders.indexOf('router.get("/orders/:id/notes"'), orders.indexOf('// PATCH /api/orders/:id/tracking'));
    expect(notes).toContain("eq(ordersTable.tenantId, req.authorizedTenantId!)");
    expect(notes).toContain("order.customerId !== actor.id");
    const kernel = source("lib/inventoryKernel.ts");
    expect(kernel).toContain("WHERE tenant_id = ${tenantId} AND transaction_id = ${transactionId}");
    expect(kernel).toContain("INSERT INTO inventory_transaction_log (tenant_id,");
  });
  it("holds unresolved payments on expiration and never restores stock from refund", () => {
    const reservations = source("lib/inventoryReservations.ts");
    expect(reservations).toContain("AND NOT EXISTS (SELECT 1 FROM payment_attempts p");
    expect(reservations).toContain("'reconciliation_required'");
    const payments = source("payments/service.ts");
    expect(payments).not.toContain("restoreInventoryBalanceThroughAuthority");
  });
});
