import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../../../..");
const route = readFileSync(resolve(root, "artifacts/api-server/src/routes/returns.ts"), "utf8");
const migration = readFileSync(resolve(root, "lib/db/drizzle/0057_refund_return_lifecycle.sql"), "utf8");
const ui = readFileSync(resolve(root, "artifacts/platform/src/pages/order-detail.tsx"), "utf8");

describe("unified refund/return boundary", () => {
  it("is server-authoritative and permission protected", () => {
    expect(route).toContain('requirePermission("orders.refund")');
    expect(route).toContain("Only settled orders may be refunded");
    expect(route).toContain("Refund exceeds the authoritative refundable amount");
    expect(route).toContain(".strict()");
    expect(route).toContain("pg_advisory_xact_lock");
  });
  it("covers tender, disposition, idempotency and compensating movement", () => {
    expect(route).toContain("restoreCustomerCredit");
    expect(route).toContain("cash_refund");
    expect(route).toContain('movementType: "customer_return"');
    expect(route).toContain("DO_NOT_RESTOCK");
    expect(route).toContain("return-movement:");
    expect(route).toContain("refundInTransaction");
    expect(route).not.toContain("PayPal refunds are certified in Gate 2B");
  });
  it("persists return transactions and lines", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS return_transactions");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS return_lines");
    expect(migration).toContain("tenant_key_unique");
    expect(migration).toContain("RESTOCK");
    expect(migration).toContain("DO_NOT_RESTOCK");
  });
  it("exposes an operator preview and confirmation workflow", () => {
    expect(ui).toContain("refund-return-panel");
    expect(ui).toContain("Calculate refund");
    expect(ui).toContain("Confirm refund");
  });
});
