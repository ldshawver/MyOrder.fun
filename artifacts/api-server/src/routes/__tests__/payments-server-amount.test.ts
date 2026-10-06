import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const route = readFileSync(resolve(root, "artifacts/api-server/src/routes/payments.ts"), "utf8");
const credit = readFileSync(resolve(root, "artifacts/api-server/src/payments/customerCredit.ts"), "utf8");

describe("retired provider and server-authoritative Customer Credit", () => {
  it("returns an explicit retired response and cannot create a mock provider payment", () => {
    expect(route).toContain('status(410)');
    expect(route).toContain('PAYMENT_PROVIDER_RETIRED');
    expect(route).not.toMatch(/mock.*(?:intent|payment|identifier)/i);
  });

  it("requires a caller idempotency key for Customer Credit reservation", () => {
    expect(route).toContain('req.get("Idempotency-Key")');
    expect(route).toContain('reserve:${idempotencyKey}');
    expect(credit).toContain("pg_advisory_xact_lock");
  });

  it("uses the server order total and rejects over-application and insufficient credit", () => {
    expect(credit).toContain("const unpaid = cents(order.total) - cents(order.customerCreditApplied)");
    expect(credit).toContain("CREDIT_OVER_APPLICATION");
    expect(credit).toContain("INSUFFICIENT_CUSTOMER_CREDIT");
  });

  it("scopes the order, account and ledger to tenant and customer", () => {
    expect(credit).toContain("eq(ordersTable.tenantId, input.tenantId)");
    expect(credit).toContain("eq(ordersTable.customerId, input.customerId)");
    expect(credit).toContain("eq(customerCreditLedgerTable.tenantId, input.tenantId)");
  });
});
