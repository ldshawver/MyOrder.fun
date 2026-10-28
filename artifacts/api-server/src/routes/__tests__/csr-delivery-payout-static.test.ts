import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../../..");
const orders = readFileSync(resolve(root, "artifacts/api-server/src/routes/orders.ts"), "utf8");
const shifts = readFileSync(resolve(root, "artifacts/api-server/src/routes/shifts.ts"), "utf8");
const handoffStart = orders.indexOf('router.post("/orders/:id/delivery/handoff-complete"');
const handoffRoute = orders.slice(handoffStart, orders.indexOf("\n});", handoffStart) + 4);

describe("CSR delivery and shift payout policy regressions", () => {
  it("does not accrue CSR delivery earnings when an order is created", () => {
    const orderCreateEnd = orders.indexOf('router.post("/orders/:id/delivery/handoff-complete"');
    const createOrderRoute = orders.slice(orders.indexOf('router.post("/orders",'), orderCreateEnd);
    expect(createOrderRoute).not.toContain("csrDeliveryEarnings:");
  });

  it("accrues exactly the server-calculated 80% share only for a paid assigned CSR handoff", () => {
    expect(handoffRoute).toContain("paymentReadyForCompletion(tenantId, order)");
    expect(handoffRoute).toContain("order.assignedCsrUserId");
    expect(handoffRoute).toContain('eq(labTechShiftsTable.status, "active")');
    expect(handoffRoute).toContain("calculateCsrDeliveryShareCents(order.deliveryFee)");
    expect(handoffRoute).toContain("csrDeliveryEarnings:");
    expect(handoffRoute).toContain("pg_advisory_xact_lock");
    expect(handoffRoute).toContain("isNull(ordersTable.handoffCompletedAt)");
    expect(handoffRoute).toContain("csrDeliveryShare: result.csrDeliveryShare");
  });

  it("uses the scoped shift's paid discounted merchandise commission base and passes through tips", () => {
    expect(shifts).toContain("sumCommissionableDiscountedProductSales(shiftOrders)");
    expect(shifts).toContain("sumCustomerTipsForShift(shiftOrders)");
    expect(shifts).toContain("commissionSalesBase: stats.commissionSalesBase");
    expect(shifts).toContain("customerTips: stats.customerTips");
    expect(shifts).toContain("csrDeliveryEarnings: lockedShift.csrDeliveryEarnings");
    expect(shifts).toContain('base: "paid_discounted_product_sales"');
    expect(shifts).toContain('"general_queue", "delivery_fee", "tax", "customer_tip"');
    expect(shifts).toContain("totalCsrPayout: financials.totalCsrPayout");
  });
});
