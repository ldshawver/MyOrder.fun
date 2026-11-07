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
const productionCompose = readFileSync(resolve(root, "deploy/docker-compose.yml"), "utf8");
const platformNginx = readFileSync(resolve(root, "deploy/nginx-spa.conf"), "utf8");
const platformHtml = readFileSync(resolve(root, "artifacts/platform/index.html"), "utf8");
const paymentSchema = readFileSync(resolve(root, "lib/db/src/schema/payments.ts"), "utf8");

describe("PayPal release security structure", () => {
  it("fails legacy Stripe endpoints closed without mock fallback reachability", () => { expect(legacy).toContain("PAYMENT_PROVIDER_RETIRED"); expect(legacy).toContain("status(410)"); expect(legacy).not.toContain("mockPayment"); });
  it("requires auth, approval, strict schemas, idempotency and refund permission", () => { expect(route).toContain("requireApproved"); expect(route).toContain(".strict()"); expect(route).toContain("Idempotency-Key"); expect(route).toContain('requirePermission("orders.refund")'); });
  it("accepts no browser total and derives the PayPal amount from the finalized server order", () => {
    expect(route).toContain("Empty.parse(req.body)");
    expect(service).toContain("order.remainingTenderAmount");
    expect(service).toContain("FINANCIAL_SNAPSHOT_MISMATCH");
    expect(frontend).not.toMatch(/body:\s*JSON\.stringify\([^)]*(?:amount|total)/);
  });
  it("serializes and deduplicates create/capture across retries and concurrent requests", () => {
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('inArray(paymentAttemptsTable.state, ["creating", "created", "approved", "capturing", "reconciliation_required"])');
    expect(service).toContain('captureOrder(attempt.providerOrderId, `capture-${attempt.id}`)');
    expect(paymentSchema).toContain('unique("payment_attempts_tenant_order_key_unique")');
    expect(paymentSchema).toContain('unique("payment_captures_provider_capture_unique")');
  });
  it("uses a raw bounded webhook and preserves the parsed raw event for signature verification", () => {
    expect(route).toContain("Buffer.isBuffer");
    expect(route).toContain("PayPal-Transmission-Sig");
    expect(route).toContain("PayPal-Cert-Url");
    expect(route).toContain("const event = parsedBody as typeof parsedEvent.data");
    expect(route).not.toContain("const event = parsedEvent.data");
  });
  it("does not load PayPal SDK until server configuration enables it", () => { expect(frontend).toContain("!config.enabled"); expect(frontend.indexOf("!config.enabled")).toBeLessThan(frontend.indexOf("document.createElement")); expect(frontend).not.toContain("paypalme"); });
  it("uses the v6 official Wallet element with only the publishable client ID and automatic presentation", () => {
    expect(frontend).toContain('tag: "paypal-button"');
    expect(frontend).toContain("createPayPalOneTimePaymentSession");
    expect(frontend).toContain('createInstance({ clientId: config.clientId, components: ["paypal-payments", "venmo-payments", "paypal-guest-payments", "applepay-payments", "googlepay-payments"], pageType: "checkout" })');
    expect(frontend).toContain("createApplePayOneTimePaymentSession");
    expect(frontend).toContain("createGooglePayOneTimePaymentSession");
    expect(frontend).toContain('methods.isEligible("applepay")');
    expect(frontend).toContain('methods.isEligible("googlepay")');
    expect(frontend).toContain('presentationMode: "auto"');
    expect(frontend).toContain('...await authHeaders()');
    expect(frontend).not.toContain("browser-token");
    expect(frontend).not.toContain("clientSecret");
    expect(frontend).not.toContain("type=\"text\" name=\"cardNumber\"");
  });
  it("does not retain the legacy browser token endpoint when Wallet uses client-ID authentication", () => {
    expect(route).not.toContain("browser-token");
  });
  it("starts a durable checkout only from the provider payment action and reuses an active provider order", () => {
    expect(checkout).toContain('createOrder={() => createCheckoutOrder("paypal")}');
    expect(checkout).toContain("Your order is created only after you start a provider-controlled payment.");
    expect(service).toContain("A new browser session must resume an existing durable PayPal order");
    expect(service).toContain('inArray(paymentAttemptsTable.state, ["created", "capturing", "reconciliation_required"])');
  });
  it("releases an explicitly cancelled buyer checkout but preserves unknown outcomes for recovery", () => {
    expect(route).toContain('/payments/paypal/orders/:orderId/cancel');
    expect(service).toContain("cancelBuyerCheckout");
    expect(service).toContain('authoritative.status !== "CREATED"');
    expect(service).toContain('failureClass: `cancellation_${failureClass}`');
    expect(frontend).toContain("server verifies that PayPal still reports an uncaptured CREATED");
    expect(frontend).toContain("Checkout remains pending for safe recovery; do not retry automatically.");
  });
  it("prefetches Apple Pay merchant configuration and constructs the native session directly in the click gesture", () => {
    expect(frontend).toContain("const merchant = await session.config()");
    expect(frontend).toContain('appleScript.crossOrigin = "anonymous"');
    expect(frontend).toContain("button.addEventListener(\"click\", startApplePay)");
    expect(frontend).toContain("click gesture. All network-dependent configuration is prefetched.");
    expect(frontend).not.toContain("const merchant = await providerSession.config()");
  });
  it("staging requires PayPal Sandbox variables and removes Stripe configuration", () => { expect(compose).toContain("PAYPAL_CLIENT_SECRET: ${PAYPAL_CLIENT_SECRET:?"); expect(compose).not.toContain("STRIPE_SECRET_KEY"); expect(compose).not.toContain("PAYPAL_API_BASE_URL"); });
  it("passes all production PayPal runtime settings into the API container", () => {
    for (const name of ["PAYMENT_MODE", "PAYMENT_PROVIDER", "PAYPAL_ENVIRONMENT", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"]) {
      expect(productionCompose).toContain(name + ": ${" + name + ":-");
    }
  });
  it("allows only the documented Apple and PayPal SDK origin families and preserves popup isolation compatibility", () => {
    for (const source of [platformNginx, platformHtml]) {
      expect(source).toContain("https://applepay.cdn-apple.com");
      expect(source).toContain("https://*.paypal.com");
      expect(source).toContain("https://*.paypalobjects.com");
      expect(source).toContain("https://*.venmo.com");
    }
    expect(platformNginx).toContain('Cross-Origin-Opener-Policy "same-origin-allow-popups"');
  });
});
