import { describe, expect, it, vi } from "vitest";
import { PayPalProvider } from "../paypal";
import type { EnabledPaymentConfig } from "../provider";

const config: EnabledPaymentConfig = { enabled: true, provider: "paypal", mode: "sandbox", environment: "sandbox", clientId: "client", clientSecret: "secret", webhookId: "webhook", apiOrigin: "https://api-m.sandbox.paypal.com" };
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }

describe("PayPal provider", () => {
  it("uses only the internally selected Sandbox host and server amount", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []; const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return calls.length === 1 ? json({ access_token: "token", expires_in: 300 }) : json({ id: "ORDER1", status: "CREATED", purchase_units: [{ amount: { value: "10.80", currency_code: "USD" } }], links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }] }); });
    const result = await new PayPalProvider(config, fetcher as typeof fetch).createOrder({ amount: { value: "10.80", currency: "USD" }, requestId: "request-1", internalOrderId: 7 });
    expect(calls.every(call => call.url.startsWith(config.apiOrigin))).toBe(true); expect(calls[1].init?.body).toContain('"value":"10.80"'); expect(result.id).toBe("ORDER1");
  });
  it("uses PayPal-Request-Id for capture idempotency", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token", expires_in: 300 })).mockResolvedValueOnce(json({ purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { value: "10.80", currency_code: "USD" } }] } }] }));
    await new PayPalProvider(config, fetcher as typeof fetch).captureOrder("ORDER1", "capture-key"); expect((fetcher.mock.calls[1][1].headers as Record<string, string>)["PayPal-Request-Id"]).toBe("capture-key");
  });
  it("verifies webhooks through PayPal with all transmission metadata", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token", expires_in: 300 })).mockResolvedValueOnce(json({ verification_status: "SUCCESS" })); const provider = new PayPalProvider(config, fetcher as typeof fetch);
    await expect(provider.verifyWebhook({ transmissionId: "id", transmissionTime: "time", transmissionSignature: "sig", certificateUrl: "https://api.paypal.com/cert", authAlgorithm: "SHA256withRSA" }, { id: "event" })).resolves.toBe(true);
    expect(fetcher.mock.calls[1][1].body).toContain('"webhook_id":"webhook"');
  });
  it("rejects invalid provider responses", async () => { const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ id: "bad" })); await expect(new PayPalProvider(config, fetcher as typeof fetch).getOrder("bad")).rejects.toMatchObject({ failureClass: "invalid_response" }); });
  it("classifies provider declines", async () => { const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({}, 422)); await expect(new PayPalProvider(config, fetcher as typeof fetch).captureOrder("ORDER1", "key")).rejects.toMatchObject({ failureClass: "declined" }); });
});
