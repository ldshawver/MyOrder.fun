import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cancelUberDelivery, createUberDelivery, getUberDelivery, listUberDeliveries, UberDirectApiError, UberDirectConfigError, normalizeUberAddress, verifyUberWebhookSignature, verifyUberWebhookSignatureForSecret } from "../uberDirect";
import { logger } from "../logger";

describe("Uber Direct security boundaries", () => {
  it("normalizes a complete plain-text delivery address into provider fields", () => {
    expect(normalizeUberAddress("500 Test Street, Testville, CA 94105")).toEqual({
      street_address: ["500 Test Street"], city: "Testville", state: "CA", zip_code: "94105", country: "US",
    });
  });

  it("rejects unknown structured address fields and incomplete client addresses", () => {
    expect(() => normalizeUberAddress('{"street_address":["500 Test Street"],"city":"Testville","state":"CA","zip_code":"94105","country":"US","tenantId":2}')).toThrow(UberDirectConfigError);
    expect(() => normalizeUberAddress("500 Test Street")).toThrow(UberDirectConfigError);
  });

  it("requires an exact HMAC of the unmodified webhook body", () => {
    const previous = process.env.UBER_DIRECT_WEBHOOK_SIGNING_KEY;
    process.env.UBER_DIRECT_WEBHOOK_SIGNING_KEY = "test-webhook-key";
    const raw = Buffer.from('{"event_id":"evt_1"}', "utf8");
    const signature = createHmac("sha256", "test-webhook-key").update(raw).digest("hex");
    expect(verifyUberWebhookSignature(raw, signature)).toBe(true);
    expect(verifyUberWebhookSignature(Buffer.from('{"event_id":"evt_2"}', "utf8"), signature)).toBe(false);
    if (previous === undefined) delete process.env.UBER_DIRECT_WEBHOOK_SIGNING_KEY;
    else process.env.UBER_DIRECT_WEBHOOK_SIGNING_KEY = previous;
  });

  it("does not accept another tenant's webhook signing key", () => {
    const raw = Buffer.from('{"event_id":"evt_1"}', "utf8");
    const tenantOneSignature = createHmac("sha256", "tenant-one-key").update(raw).digest("hex");
    expect(verifyUberWebhookSignatureForSecret(raw, tenantOneSignature, "tenant-one-key")).toBe(true);
    expect(verifyUberWebhookSignatureForSecret(raw, tenantOneSignature, "tenant-two-key")).toBe(false);
  });

  it("uses the Direct external_id contract and supports bounded lookup and cancellation", async () => {
    const config = { tenantId: 917, environment: "sandbox" as const, customerId: "synthetic-customer", clientId: "synthetic-uber-client-917", clientSecret: "synthetic-uber-secret" };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (String(input).includes("/oauth/")) return new Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600 }), { status: 200 });
      if (String(input).includes("/cancel")) return new Response(JSON.stringify({ id: "del_synthetic", status: "canceled" }), { status: 200 });
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "del_synthetic", status: "pending" }), { status: 200 });
      if (String(input).includes("?limit=")) return new Response(JSON.stringify({ data: [{ id: "del_synthetic", external_id: "myorder-917-42", quote_id: "dqt_synthetic", status: "pending" }], next_href: null, total_count: -1 }), { status: 200 });
      return new Response(JSON.stringify({ id: "del_synthetic", external_id: "myorder-917-42", status: "pending" }), { status: 200 });
    });
    try {
      const address = normalizeUberAddress("500 Test Street, Testville, CA 94105");
      await createUberDelivery({ quoteId: "dqt_synthetic", externalOrderReference: "myorder-917-42", pickupAddress: address, pickupName: "Test Shop", pickupPhoneNumber: "+15555550111", dropoffAddress: address, dropoffName: "Test Customer", dropoffPhoneNumber: "+15555550222", manifestItems: [{ name: "Test Item", quantity: 1 }] }, config);
      const createCall = calls.find(call => call.init.method === "POST" && !call.url.includes("/cancel") && !call.url.includes("/oauth/"));
      expect(JSON.parse(String(createCall?.init.body))).toMatchObject({ external_id: "myorder-917-42", quote_id: "dqt_synthetic" });
      expect(JSON.parse(String(createCall?.init.body))).not.toHaveProperty("external_order_id");
      expect((await listUberDeliveries(config)).deliveries).toHaveLength(1);
      expect((await getUberDelivery("del_synthetic", config)).external_id).toBe("myorder-917-42");
      expect((await cancelUberDelivery("del_synthetic", config)).status).toBe("canceled");
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    } finally { fetchSpy.mockRestore(); }
  });

  it("does not log an untrusted provider error code that could contain a secret", async () => {
    let providerCode = "invalid secret=synthetic-private-value";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/oauth/")) return new Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ code: providerCode }), { status: 400 });
    });
    const logSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const address = normalizeUberAddress("500 Test Street, Testville, CA 94105");
      await expect(createUberDelivery({ quoteId: "dqt_synthetic", externalOrderReference: "myorder-918-42", pickupAddress: address, pickupName: "Test Shop", pickupPhoneNumber: "+15555550111", dropoffAddress: address, dropoffName: "Test Customer", dropoffPhoneNumber: "+15555550222", manifestItems: [{ name: "Test Item", quantity: 1 }] },
        { tenantId: 918, environment: "sandbox", customerId: "synthetic-customer", clientId: "synthetic-uber-client-918", clientSecret: "synthetic-uber-secret" }))
        .rejects.toMatchObject({ name: UberDirectApiError.name, code: null });
      expect(logSpy).toHaveBeenCalledWith({ status: 400, code: null }, "Uber Direct delivery creation failed");
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("synthetic-private-value");
      providerCode = "synthetic_private_token_123";
      await expect(createUberDelivery({ quoteId: "dqt_synthetic", externalOrderReference: "myorder-918-43", pickupAddress: address, pickupName: "Test Shop", pickupPhoneNumber: "+15555550111", dropoffAddress: address, dropoffName: "Test Customer", dropoffPhoneNumber: "+15555550222", manifestItems: [{ name: "Test Item", quantity: 1 }] },
        { tenantId: 918, environment: "sandbox", customerId: "synthetic-customer", clientId: "synthetic-uber-client-918", clientSecret: "synthetic-uber-secret" }))
        .rejects.toMatchObject({ code: null });
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(providerCode);
    } finally { fetchSpy.mockRestore(); logSpy.mockRestore(); }
  });

  it("requires the provider create response to match the requested order and quote", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/oauth/")) return new Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ id: "del_wrong", external_id: "myorder-other-tenant", quote_id: "dqt_wrong", status: "pending" }), { status: 200 });
    });
    try {
      const address = normalizeUberAddress("500 Test Street, Testville, CA 94105");
      await expect(createUberDelivery({ quoteId: "dqt_expected", externalOrderReference: "myorder-919-42", pickupAddress: address, pickupName: "Test Shop", pickupPhoneNumber: "+15555550111", dropoffAddress: address, dropoffName: "Test Customer", dropoffPhoneNumber: "+15555550222", manifestItems: [{ name: "Test Item", quantity: 1 }] },
        { tenantId: 919, environment: "sandbox", customerId: "synthetic-customer", clientId: "synthetic-uber-client-919", clientSecret: "synthetic-uber-secret" }))
        .rejects.toMatchObject({ code: "delivery_identity_mismatch" });
    } finally { fetchSpy.mockRestore(); }
  });
});
