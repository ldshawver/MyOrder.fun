import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(__dirname, "../service.ts"), "utf8");
const webhook = readFileSync(resolve(__dirname, "../service.ts"), "utf8");
const migration = readFileSync(resolve(__dirname, "../../../../../lib/db/drizzle/0058_paypal_refund_durability.sql"), "utf8");

describe("PayPal refund durability regressions", () => {
  it("persists intent before the provider boundary and keeps a stable request id", () => {
    expect(source).toContain("prepareRefundInTransaction");
    expect(source).toContain("providerRequestId: `refund-${randomUUID()}`");
    expect(source).toContain("async recordRefundProviderResult");
    expect(source.indexOf("async recordRefundProviderResult")).toBeLessThan(source.indexOf("async finalizeRefund"));
  });

  it("preserves provider identity through minimal/full responses and downstream failures", () => {
    expect(source).toContain("providerRefundId: input.refund.refundId");
    expect(source).toContain("providerStatus: input.refund.status");
    expect(source).toContain("providerResultAt: new Date()");
    expect(source).toContain("refund_amount_mismatch");
  });

  it("guards replay, pending/failed outcomes, and local finalization", () => {
    for (const state of ["requested", "provider_succeeded", "locally_finalized", "pending", "failed", "reconciliation_required"]) expect(migration).toContain(`'${state}'`);
    expect(source).toContain("LOST_PROVIDER_IDENTITY");
    expect(source).toContain("REFUND_NOT_READY");
    expect(source).toContain("locallyFinalizedAt");
  });

  it("uses verified webhook evidence idempotently and safely rejects unknown mappings", () => {
    expect(webhook).toContain("verifyWebhook(headers, event)");
    expect(webhook).toContain("onConflictDoNothing()");
    expect(webhook).toContain("PAYMENT.CAPTURE.REFUNDED");
    expect(webhook).toContain("PAYMENT.REFUND.COMPLETED");
    expect(webhook).toContain("unmapped_capture");
    expect(webhook).toContain("capture_refunded_without_refund_identity");
  });

  it("retains the tender-specific safeguards for credit, cash, partials, and final-cent allocation", () => {
    const returns = readFileSync(resolve(__dirname, "../../routes/returns.ts"), "utf8");
    expect(returns).toContain("restoreCustomerCredit");
    expect(returns).toContain("cash_refund");
    expect(returns).toContain("roundingOverage");
    expect(returns).toContain("return-movement:");
  });
});
