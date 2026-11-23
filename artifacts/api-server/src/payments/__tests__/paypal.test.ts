import { describe, expect, it, vi } from "vitest";
import { PayPalProvider } from "../paypal";
import type { EnabledPaymentConfig } from "../provider";

const config: EnabledPaymentConfig = { enabled: true, provider: "paypal", mode: "sandbox", environment: "sandbox", clientId: "client", clientSecret: "secret", webhookId: "webhook", apiOrigin: "https://api-m.sandbox.paypal.com" };
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }

describe("PayPal provider", () => {
  it("uses only the internally selected Sandbox host and server amount", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []; const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return calls.length === 1 ? json({ access_token: "token", expires_in: 300 }) : json({ id: "ORDER1", status: "CREATED", purchase_units: [{ reference_id: "7", amount: { value: "10.80", currency_code: "USD" } }], links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }] }); });
    const result = await new PayPalProvider(config, fetcher as typeof fetch).createOrder({ amount: { value: "10.80", currency: "USD" }, requestId: "request-1", internalOrderId: 7 });
    expect(calls.every(call => call.url.startsWith(config.apiOrigin))).toBe(true); expect(calls[1].init?.body).toContain('"value":"10.80"'); expect(result.id).toBe("ORDER1");
  });
  it.each([
    "https://evil.example/checkoutnow?token=ORDER1",
    "http://www.sandbox.paypal.com/checkoutnow?token=ORDER1",
    "https://www.sandbox.paypal.com.evil.example/checkoutnow?token=ORDER1",
    "not-a-url",
  ])("rejects an untrusted approval redirect %s", async href => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "ORDER1", status: "CREATED", purchase_units: [{ reference_id: "7", amount: { value: "10.80", currency_code: "USD" } }], links: [{ rel: "payer-action", href }] }));
    await expect(new PayPalProvider(config, fetcher as typeof fetch).createOrder({ amount: { value: "10.80", currency: "USD" }, requestId: "request-1", internalOrderId: 7 })).rejects.toMatchObject({ failureClass: "invalid_response" });
  });
  it("accepts only the configured live PayPal approval origin in live mode", async () => {
    const liveConfig: EnabledPaymentConfig = { ...config, mode: "live", environment: "live", apiOrigin: "https://api-m.paypal.com" };
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "ORDER1", status: "CREATED", purchase_units: [{ reference_id: "7", amount: { value: "10.80", currency_code: "USD" } }], links: [{ rel: "approve", href: "https://www.paypal.com/checkoutnow?token=ORDER1" }] }));
    await expect(new PayPalProvider(liveConfig, fetcher as typeof fetch).createOrder({ amount: { value: "10.80", currency: "USD" }, requestId: "request-1", internalOrderId: 7 })).resolves.toMatchObject({ approvalUrl: "https://www.paypal.com/checkoutnow?token=ORDER1" });
  });
  it("uses PayPal-Request-Id for capture idempotency", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token", expires_in: 300 })).mockResolvedValueOnce(json({ id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { value: "10.80", currency_code: "USD" } }] } }] }));
    await new PayPalProvider(config, fetcher as typeof fetch).captureOrder("ORDER1", "capture-key"); expect((fetcher.mock.calls[1][1].headers as Record<string, string>)["PayPal-Request-Id"]).toBe("capture-key");
  });
  it.each([
    ["a mismatched internal reference", { reference_id: "8", amount: { value: "10.80", currency_code: "USD" } }],
    ["a mismatched amount", { reference_id: "7", amount: { value: "9.80", currency_code: "USD" } }],
    ["a mismatched currency", { reference_id: "7", amount: { value: "10.80", currency_code: "CAD" } }],
  ])("rejects create-order representation with %s", async (_label, unit) => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "ORDER1", status: "CREATED", purchase_units: [unit] }));
    await expect(new PayPalProvider(config, fetcher as typeof fetch).createOrder({ amount: { value: "10.80", currency: "USD" }, requestId: "request-1", internalOrderId: 7 })).rejects.toMatchObject({ failureClass: "invalid_response" });
  });
  it("rejects ambiguous extra purchase units and captures", async () => {
    const unit = { reference_id: "7", amount: { value: "10.80", currency_code: "USD" } };
    const createFetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "ORDER1", status: "CREATED", purchase_units: [unit, unit] }));
    await expect(new PayPalProvider(config, createFetcher as typeof fetch).createOrder({ amount: { value: "10.80", currency: "USD" }, requestId: "request-1", internalOrderId: 7 })).rejects.toMatchObject({ failureClass: "invalid_response" });

    const capture = { id: "CAP1", status: "COMPLETED", amount: { value: "10.80", currency_code: "USD" } };
    const captureFetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: { captures: [capture, { ...capture, id: "CAP2" }] } }] }));
    await expect(new PayPalProvider(config, captureFetcher as typeof fetch).captureOrder("ORDER1", "capture-key")).rejects.toMatchObject({ failureClass: "invalid_response" });

    const lookupFetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "ORDER1", status: "COMPLETED", purchase_units: [{ amount: unit.amount, payments: { captures: [capture, { ...capture, id: "CAP2" }] } }] }));
    await expect(new PayPalProvider(config, lookupFetcher as typeof fetch).getOrder("ORDER1")).rejects.toMatchObject({ failureClass: "invalid_response" });
  });
  it.each([
    ["venmo", { venmo: {} }, "venmo"],
    ["Apple Pay", { apple_pay: {} }, "apple_pay"],
    ["Google Pay", { google_pay: {} }, "google_pay"],
    ["debit card", { card: { card_type: "DEBIT" } }, "debit"],
    ["credit card", { card: { card_type: "CREDIT" } }, "credit"],
    ["PayPal", { paypal: {} }, "paypal"],
  ])("records the verified %s funding source", async (_label, paymentSource, expected) => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token", expires_in: 300 })).mockResolvedValueOnce(json({ id: "ORDER1", status: "COMPLETED", payment_source: paymentSource, purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { value: "10.80", currency_code: "USD" } }] } }] }));
    await expect(new PayPalProvider(config, fetcher as typeof fetch).captureOrder("ORDER1", "capture-key")).resolves.toMatchObject({ fundingSource: expected });
  });
  it("verifies webhooks through PayPal with all transmission metadata", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token", expires_in: 300 })).mockResolvedValueOnce(json({ verification_status: "SUCCESS" })); const provider = new PayPalProvider(config, fetcher as typeof fetch);
    await expect(provider.verifyWebhook({ transmissionId: "id", transmissionTime: "time", transmissionSignature: "sig", certificateUrl: "https://api.paypal.com/cert", authAlgorithm: "SHA256withRSA" }, { id: "event" })).resolves.toBe(true);
    expect(fetcher.mock.calls[1][1].body).toContain('"webhook_id":"webhook"');
  });
  it("rejects invalid provider responses", async () => { const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "bad" })); await expect(new PayPalProvider(config, fetcher as typeof fetch).getOrder("bad")).rejects.toMatchObject({ failureClass: "invalid_response" }); });
  it("rejects blank provider resource identities", async () => {
    const createFetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: " ", status: "CREATED", purchase_units: [{ reference_id: "7", amount: { value: "10.80", currency_code: "USD" } }] }));
    await expect(new PayPalProvider(config, createFetcher as typeof fetch).createOrder({ amount: { value: "10.80", currency: "USD" }, requestId: "request-1", internalOrderId: 7 })).rejects.toMatchObject({ failureClass: "invalid_response" });

    const captureFetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: " ", status: "COMPLETED", amount: { value: "10.80", currency_code: "USD" } }] } }] }));
    await expect(new PayPalProvider(config, captureFetcher as typeof fetch).captureOrder("ORDER1", "capture-key")).rejects.toMatchObject({ failureClass: "invalid_response" });

    const refundFetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: " ", status: "COMPLETED" }));
    await expect(new PayPalProvider(config, refundFetcher as typeof fetch).refundCapture("CAP1", { value: "10.80", currency: "USD" }, "refund-key", "test")).rejects.toMatchObject({ failureClass: "invalid_response" });
  });
  it("rejects read responses whose provider identity does not match the requested resource", async () => {
    const orderFetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "ORDER2", status: "COMPLETED", purchase_units: [{ amount: { value: "10.80", currency_code: "USD" } }] }));
    await expect(new PayPalProvider(config, orderFetcher as typeof fetch).getOrder("ORDER1")).rejects.toMatchObject({ failureClass: "invalid_response" });

    const captureFetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "CAP2", status: "COMPLETED", amount: { value: "10.80", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: "ORDER1" } } }));
    await expect(new PayPalProvider(config, captureFetcher as typeof fetch).getCapture("CAP1")).rejects.toMatchObject({ failureClass: "invalid_response" });
  });
  it("rejects a capture representation for a different provider order", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "ORDER2", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { value: "10.80", currency_code: "USD" } }] } }] }));
    await expect(new PayPalProvider(config, fetcher as typeof fetch).captureOrder("ORDER1", "capture-key")).rejects.toMatchObject({ failureClass: "invalid_response" });
  });
  it("rejects unknown order and capture lifecycle states", async () => {
    const createFetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "ORDER1", status: "SURPRISE", purchase_units: [{ reference_id: "7", amount: { value: "10.80", currency_code: "USD" } }] }));
    await expect(new PayPalProvider(config, createFetcher as typeof fetch).createOrder({ amount: { value: "10.80", currency: "USD" }, requestId: "request-1", internalOrderId: 7 })).rejects.toMatchObject({ failureClass: "invalid_response" });

    const captureFetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "SURPRISE", amount: { value: "10.80", currency_code: "USD" } }] } }] }));
    await expect(new PayPalProvider(config, captureFetcher as typeof fetch).captureOrder("ORDER1", "capture-key")).rejects.toMatchObject({ failureClass: "invalid_response" });

    const lookupFetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "CAP1", status: "SURPRISE", amount: { value: "10.80", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: "ORDER1" } } }));
    await expect(new PayPalProvider(config, lookupFetcher as typeof fetch).getCapture("CAP1")).rejects.toMatchObject({ failureClass: "invalid_response" });
  });
  it("classifies provider declines", async () => { const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({}, 422)); await expect(new PayPalProvider(config, fetcher as typeof fetch).captureOrder("ORDER1", "key")).rejects.toMatchObject({ failureClass: "declined" }); });
  it("treats a transport failure after sending a mutation as an unknown outcome", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockRejectedValueOnce(new TypeError("connection reset"));
    await expect(new PayPalProvider(config, fetcher as typeof fetch).createOrder({ amount: { value: "10.80", currency: "USD" }, requestId: "request-1", internalOrderId: 7 })).rejects.toMatchObject({ failureClass: "unknown_outcome" });
  });
  it("keeps authentication and read-only transport failures retryable", async () => {
    const authFailure = vi.fn().mockRejectedValueOnce(new TypeError("connection refused"));
    await expect(new PayPalProvider(config, authFailure as typeof fetch).createOrder({ amount: { value: "10.80", currency: "USD" }, requestId: "request-1", internalOrderId: 7 })).rejects.toMatchObject({ failureClass: "provider_error" });

    const lookupFailure = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockRejectedValueOnce(new TypeError("connection reset"));
    await expect(new PayPalProvider(config, lookupFailure as typeof fetch).getOrder("ORDER1")).rejects.toMatchObject({ failureClass: "provider_error" });
  });
  it("rejects oversized provider responses before parsing them", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(new Response("x", { headers: { "content-length": String(1024 * 1024 + 1) } }));
    await expect(new PayPalProvider(config, fetcher as typeof fetch).getOrder("ORDER1")).rejects.toMatchObject({ failureClass: "invalid_response" });
  });
  it("rejects malformed provider JSON as an invalid response", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(new Response("not-json"));
    await expect(new PayPalProvider(config, fetcher as typeof fetch).getOrder("ORDER1")).rejects.toMatchObject({ failureClass: "invalid_response" });
  });
  it("accepts a completed represented refund and sends the representation preference", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "REF1", status: "COMPLETED", amount: { value: "10.80", currency_code: "USD" } }));
    const result = await new PayPalProvider(config, fetcher as typeof fetch).refundCapture("CAP1", { value: "10.80", currency: "USD" }, "refund-key", "test");
    expect(result).toEqual({ refundId: "REF1", status: "COMPLETED", amount: { value: "10.80", currency: "USD" } });
    expect((fetcher.mock.calls[1][1].headers as Record<string, string>).Prefer).toBe("return=representation");
  });
  it("preserves a valid completed minimal refund response for durable service validation", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "REF2", status: "COMPLETED", links: [] }));
    await expect(new PayPalProvider(config, fetcher as typeof fetch).refundCapture("CAP1", { value: "10.80", currency: "USD" }, "refund-key", "test")).resolves.toEqual({ refundId: "REF2", status: "COMPLETED" });
  });
  it.each(["PENDING", "FAILED", "CANCELLED"])("accepts recognized non-final refund status %s", async status => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "REF3", status }));
    await expect(new PayPalProvider(config, fetcher as typeof fetch).refundCapture("CAP1", { value: "10.80", currency: "USD" }, "refund-key", "test")).resolves.toMatchObject({ refundId: "REF3", status });
  });
  it("rejects unknown, missing-id, and malformed refund identities while deferring optional amount validation", async () => {
    for (const response of [{ id: "REF", status: "MYSTERY" }, { status: "COMPLETED" }, { id: "REF", status: "COMPLETED", amount: null }]) {
      const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json(response));
      await expect(new PayPalProvider(config, fetcher as typeof fetch).refundCapture("CAP1", { value: "10.80", currency: "USD" }, "refund-key", "test")).rejects.toMatchObject({ failureClass: "invalid_response" });
    }
  });
  it("returns a mismatched optional amount so the service can persist the identity before reconciliation", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "REF", status: "COMPLETED", amount: { value: "9.00", currency_code: "USD" } }));
    await expect(new PayPalProvider(config, fetcher as typeof fetch).refundCapture("CAP1", { value: "10.80", currency: "USD" }, "refund-key", "test")).resolves.toEqual({ refundId: "REF", status: "COMPLETED", amount: { value: "9.00", currency: "USD" } });
  });
  it("classifies refund HTTP errors", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({}, 500));
    await expect(new PayPalProvider(config, fetcher as typeof fetch).refundCapture("CAP1", { value: "10.80", currency: "USD" }, "refund-key", "test")).rejects.toMatchObject({ failureClass: "provider_error" });
  });
});
