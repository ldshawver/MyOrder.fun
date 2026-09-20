import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const route = readFileSync(resolve(root, "artifacts/api-server/src/routes/paypal-payments.ts"), "utf8");
const legacy = readFileSync(resolve(root, "artifacts/api-server/src/routes/payments.ts"), "utf8");
const frontend = readFileSync(resolve(root, "artifacts/platform/src/components/PayPalCheckoutButton.tsx"), "utf8");
const checkout = readFileSync(resolve(root, "artifacts/platform/src/pages/new-order.tsx"), "utf8");
const service = readFileSync(resolve(root, "artifacts/api-server/src/payments/service.ts"), "utf8");
const compose = readFileSync(resolve(root, "deploy/docker-compose.staging.yml"), "utf8");

describe("PayPal release security structure", () => {
  it("fails legacy Stripe endpoints closed without mock fallback reachability", () => { expect(legacy).toContain("PAYMENT_PROVIDER_RETIRED"); expect(legacy).toContain("status(410)"); expect(legacy).not.toContain("mockPayment"); });
  it("requires auth, approval, strict schemas, idempotency and refund permission", () => { expect(route).toContain("requireApproved"); expect(route).toContain(".strict()"); expect(route).toContain("Idempotency-Key"); expect(route).toContain('requirePermission("orders.refund")'); });
  it("uses a raw bounded webhook and signature metadata", () => { expect(route).toContain("Buffer.isBuffer"); expect(route).toContain("PayPal-Transmission-Sig"); expect(route).toContain("PayPal-Cert-Url"); });
  it("does not load PayPal SDK until server configuration enables it", () => { expect(frontend.indexOf("if (!config.enabled")).toBeLessThan(frontend.indexOf("document.createElement")); expect(frontend).not.toContain("paypalme"); });
  it("uses PayPal SDK v6's official Wallet element and hosted-card eligibility, not an application imitation", () => {
    expect(frontend).toContain('document.createElement("paypal-button")');
    expect(frontend).toContain("createPayPalOneTimePaymentSession");
    expect(frontend).toContain("createCardFieldsOneTimePaymentSession");
    expect(frontend).toContain('methods.isEligible("advanced_cards")');
    expect(frontend).not.toContain("type=\"text\" name=\"cardNumber\"");
  });
  it("starts a durable checkout only from the provider payment action and reuses an active provider order", () => {
    expect(checkout).toContain('createOrder={() => createCheckoutOrder("paypal")}');
    expect(checkout).toContain("Your order is created only after you start a provider-controlled payment.");
    expect(service).toContain("A new browser session must resume an existing durable PayPal order");
    expect(service).toContain('inArray(paymentAttemptsTable.state, ["created", "capturing", "reconciliation_required"])');
  });
  it("staging requires PayPal Sandbox variables and removes Stripe configuration", () => { expect(compose).toContain("PAYPAL_CLIENT_SECRET: ${PAYPAL_CLIENT_SECRET:?"); expect(compose).not.toContain("STRIPE_SECRET_KEY"); expect(compose).not.toContain("PAYPAL_API_BASE_URL"); });
});
