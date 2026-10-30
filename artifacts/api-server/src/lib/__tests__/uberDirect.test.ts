import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildUberQuotePayload, cancelUberDelivery, createUberDelivery, createUberDeliveryQuote, getUberDelivery, listUberDeliveries, UberDirectApiError, UberDirectConfigError, normalizeUberAddress, verifyUberWebhookSignature, verifyUberWebhookSignatureForSecret } from "../uberDirect";
import { validateUberQuoteSettings } from "../uberDirectConfig";
import { logger } from "../logger";

describe("Uber Direct security boundaries", () => {
  it("builds the reviewed quote shape with synthetic server-owned values and exact provider types", () => {
    const payload = buildUberQuotePayload({
      pickupAddress: "100 Synthetic Pickup Way, Fixture City, CA 90001",
      dropoffAddress: "200 Synthetic Dropoff Way, Fixture City, CA 90002",
      pickupLatitude: 34.000001, pickupLongitude: -118.000001,
      pickupReadyAt: new Date("2026-11-02T18:00:00.000Z"), pickupDeadlineAt: new Date("2026-11-02T18:20:00.000Z"),
      dropoffReadyAt: new Date("2026-11-02T18:20:00.000Z"), dropoffDeadlineAt: new Date("2026-11-02T19:20:00.000Z"),
      pickupPhoneNumber: "+15555550101", dropoffPhoneNumber: "+15555550102",
      manifestTotalValue: 4321, externalStoreId: "synthetic-store-fixture-917",
    });
    expect(Object.keys(payload)).toEqual(["pickup_address", "dropoff_address", "pickup_latitude", "pickup_longitude", "pickup_ready_dt", "pickup_deadline_dt", "dropoff_ready_dt", "dropoff_deadline_dt", "pickup_phone_number", "dropoff_phone_number", "manifest_total_value", "external_store_id"]);
    expect(payload).toMatchObject({ pickup_address: "100 Synthetic Pickup Way, Fixture City, CA 90001, US", pickup_latitude: 34.000001, manifest_total_value: 4321, external_store_id: "synthetic-store-fixture-917" });
    expect(typeof payload.pickup_latitude).toBe("number");
    expect(typeof payload.manifest_total_value).toBe("number");
    expect(payload).not.toHaveProperty("manifest_items");
    expect(payload).not.toHaveProperty("pickup_action");
  });

  it("fails closed when authoritative quote configuration is incomplete or invalid", () => {
    const complete = { pickupLocationId: 91, pickupLatitude: 34.000001, pickupLongitude: -118.000001, externalStoreId: "synthetic-store-fixture-917", pickupWindowMinutes: 20, dropoffWindowMinutes: 60 };
    expect(validateUberQuoteSettings(complete)).toEqual(complete);
    expect(validateUberQuoteSettings({ ...complete, pickupLatitude: null })).toBeNull();
    expect(validateUberQuoteSettings({ ...complete, externalStoreId: null })).toBeNull();
    expect(validateUberQuoteSettings({ ...complete, pickupWindowMinutes: 0 })).toBeNull();
  });

  it("sends the reviewed quote body to the configured customer path without dispatching", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("/oauth/")) return new Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600 }), { status: 200 });
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "dqt_synthetic_fixture", fee: 1099, expires: "2026-11-02T18:15:00.000Z", dropoff_eta: "2026-11-02T19:00:00.000Z" }), { status: 200 });
    });
    try {
      await createUberDeliveryQuote({ pickupAddress: "100 Synthetic Pickup Way, Fixture City, CA 90001", dropoffAddress: "200 Synthetic Dropoff Way, Fixture City, CA 90002", pickupLatitude: 34.000001, pickupLongitude: -118.000001, pickupReadyAt: new Date("2026-11-02T18:00:00.000Z"), pickupDeadlineAt: new Date("2026-11-02T18:20:00.000Z"), dropoffReadyAt: new Date("2026-11-02T18:20:00.000Z"), dropoffDeadlineAt: new Date("2026-11-02T19:20:00.000Z"), pickupPhoneNumber: "+15555550101", dropoffPhoneNumber: "+15555550102", manifestTotalValue: 4321, externalStoreId: "synthetic-store-fixture-917" }, { tenantId: 917, environment: "sandbox", customerId: "synthetic-customer-fixture", clientId: "synthetic-client-fixture", clientSecret: "synthetic-secret-fixture" });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("/v1/customers/synthetic-customer-fixture/delivery_quotes");
      expect(calls[0].url).not.toContain("/deliveries/");
      expect(calls[0].body.manifest_total_value).toBe(4321);
    } finally { fetchSpy.mockRestore(); }
  });
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
