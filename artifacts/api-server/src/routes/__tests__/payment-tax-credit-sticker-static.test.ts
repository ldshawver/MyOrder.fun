import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("payment and sticker release invariants", () => {
  it("exposes only approved customer checkout tenders", () => {
    const orders = read("artifacts/api-server/src/routes/orders.ts");
    for (const tender of ['id: "cash"', 'id: "paypal"', 'id: "paypal_card"', 'id: "customer_credit"']) expect(orders).toContain(tender);
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

  it("fails closed and exclusively routes stickers to MARKLIFE_X2", () => {
    const bridge = read("deploy/print-bridge/server.js");
    expect(bridge).toContain('THANK_YOU_STICKER_QUEUE = "MARKLIFE_X2"');
    expect(bridge).toContain("THANK_YOU_STICKER_PRINTER_MISMATCH");
    expect(bridge).toContain('role !== "thank_you_sticker" && printableText && DIRECT_PRINTER_IP');
  });
});
