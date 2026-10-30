import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("customer checkout approval wiring", () => {
  it("scopes the compatibility policy to customer checkout POST routes", () => {
    const orders = read("api-server/src/routes/orders.ts");
    expect(orders).toContain("CUSTOMER_CHECKOUT_POST_PATHS");
    expect(orders).toContain('"/cart/convert"');
    expect(orders).toContain('"/checkout/quote"');
    expect(orders).toContain('"/orders"');
    expect(orders).toContain("requireCustomerCheckoutAccess(req, res, next)");
    expect(orders).toContain("requireApproved(req, res, next)");
    expect(orders).toContain("requireOrderRouteApproval, requireTenantContext");
  });

  it("loads payment config and performs customer PayPal actions under the customer policy", () => {
    const paypal = read("api-server/src/routes/paypal-payments.ts");
    expect(paypal).toContain("const customerAuth = [limiter, requireAuth, loadDbUser, requireDbUser, requireCustomerCheckoutAccess, requireTenantContext]");
    expect(paypal).toContain('router.get("/payments/config", ...customerAuth');
    expect(paypal).toContain('router.post("/payments/paypal/orders/:orderId", ...customerAuth');
    expect(paypal).toContain('router.post("/payments/paypal/orders/:orderId/capture", ...customerAuth');
  });

  it("limits the legacy customer policy in the credit-payment router to payment URLs", () => {
    const payments = read("api-server/src/routes/payments.ts");
    expect(payments).toContain('router.use("/payments", requireAuth, loadDbUser, requireDbUser, requireCustomerCheckoutAccess)');
    expect(payments).not.toContain("router.use(requireAuth, loadDbUser, requireDbUser, requireCustomerCheckoutAccess)");
  });

  it("retains complete provenance and permission checks for PayPal administration", () => {
    const paypal = read("api-server/src/routes/paypal-payments.ts");
    expect(paypal).toContain("const adminAuth = [limiter, requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext]");
    expect(paypal).toContain('router.post("/admin/payments/paypal/orders/:orderId/refund", ...adminAuth, requirePermission("orders.refund")');
    expect(paypal).toContain('router.get("/admin/payments/paypal/orders/:orderId/reconciliation", ...adminAuth, requirePermission("orders.refund")');
  });
});
