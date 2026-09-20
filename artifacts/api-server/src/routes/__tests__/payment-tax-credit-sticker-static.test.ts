import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("payment and sticker release invariants", () => {
  it("exposes only configured customer checkout tenders and keeps card funding inside PayPal", () => {
    const orders = read("artifacts/api-server/src/routes/orders.ts");
    for (const tender of ['id: "cash"', 'id: "paypal"', 'id: "customer_credit"']) expect(orders).toContain(tender);
    expect(orders).not.toContain('id: "paypal_card"');
    expect(read("artifacts/api-server/src/payments/service.ts")).toContain('capture.fundingSource === "card" ? "paypal_card" : "paypal"');
    for (const retired of ['id: "stripe"', 'id: "gift_card"', 'id: "manual"', 'id: "cash_app"']) expect(orders).not.toContain(retired);
  });

  it("retires Stripe routes without mock identifiers and preserves historical storage", () => {
    const route = read("artifacts/api-server/src/routes/payments.ts");
    expect(route).toContain("PAYMENT_PROVIDER_RETIRED"); expect(route).not.toContain("pi_sandbox"); expect(route).not.toContain("PaymentIntent");
    const migration = read("lib/db/drizzle/0043_payments_tax_credit_stickers.sql");
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN).*stripe/i);
    expect(read("deploy/docker-compose.yml")).not.toContain("STRIPE_SECRET_KEY");
    expect(read("deploy/docker-compose.staging.yml")).not.toContain("STRIPE_SECRET_KEY");
  });

  it("keeps bridge printing authenticated without a queue-name business policy", () => {
    const bridge = read("deploy/print-bridge/server.js");
    expect(bridge).not.toContain('THANK_YOU_STICKER_QUEUE = "MARKLIFE_X2"');
    expect(bridge).toContain("PRINT_BRIDGE_API_KEY");
    expect(bridge).toContain("discoveryConfigured");
    expect(bridge).not.toContain("THANK_YOU_STICKER_PRINTER_MISMATCH");
  });
});
