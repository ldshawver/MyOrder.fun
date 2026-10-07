import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWooWebhookSignature } from "../woocommerce-webhooks";

describe("WooCommerce webhook signature verification", () => {
  it("verifies the original raw request bytes using Woo's base64 HMAC-SHA256 signature", () => {
    const body = Buffer.from('{"id":25,"name":"variant test"}');
    const secret = "test-only-signing-secret";
    const signature = createHmac("sha256", secret).update(body).digest("base64");
    expect(verifyWooWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifyWooWebhookSignature(Buffer.from('{ "id":25,"name":"variant test"}'), signature, secret)).toBe(false);
    expect(verifyWooWebhookSignature(body, signature, "different-secret")).toBe(false);
  });

  it("rejects empty body, signature, or secret", () => {
    expect(verifyWooWebhookSignature(Buffer.alloc(0), "signature", "secret")).toBe(false);
    expect(verifyWooWebhookSignature(Buffer.from("{}"), "", "secret")).toBe(false);
    expect(verifyWooWebhookSignature(Buffer.from("{}"), "signature", "")).toBe(false);
  });
});
