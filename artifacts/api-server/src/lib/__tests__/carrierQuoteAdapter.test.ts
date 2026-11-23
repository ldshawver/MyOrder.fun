import { describe, expect, it } from "vitest";
import { acceptCarrierQuoteResponse, configureCarrierQuoteAdapter, createDurableCarrierQuote, requireConfiguredCarrierQuoteAdapter } from "../carrierQuoteAdapter";

const now = new Date("2026-11-23T12:00:00.000Z");
const context = {
  provider: "sandbox_carrier",
  cartFingerprint: "cart-server-fingerprint",
  destination: { countryCode: "us", postalCode: " 90210 ", address: " 123 Main Street " },
};
const response = {
  quoteId: "provider-quote-1",
  serviceCode: "ground",
  serviceName: "Ground",
  feeCents: 1299,
  currency: "USD",
  expiresAt: "2026-11-23T12:15:00.000Z",
  estimatedDeliveryAt: "2026-11-25T18:00:00.000Z",
};

describe("carrier quote adapter contract", () => {
  it("fails closed until a reviewed process adapter is configured", () => {
    configureCarrierQuoteAdapter(null);
    expect(() => requireConfiguredCarrierQuoteAdapter()).toThrow("CARRIER_PROVIDER_UNAVAILABLE");
    const adapter = { provider: context.provider, quote: async () => response };
    configureCarrierQuoteAdapter(adapter);
    expect(requireConfiguredCarrierQuoteAdapter()).toBe(adapter);
    configureCarrierQuoteAdapter(null);
  });
  it("keeps cart and destination authority in the server request context", () => {
    expect(acceptCarrierQuoteResponse(context, response, now)).toEqual({
      provider: "sandbox_carrier",
      providerQuoteId: "provider-quote-1",
      cartFingerprint: "cart-server-fingerprint",
      destinationSnapshot: { countryCode: "US", postalCode: "90210", address: "123 Main Street" },
      serviceSnapshot: { code: "ground", name: "Ground", estimatedDeliveryAt: "2026-11-25T18:00:00.000Z" },
      feeCents: 1299,
      currency: "usd",
      expiresAt: new Date("2026-11-23T12:15:00.000Z"),
    });
  });

  it.each([
    [{ ...response, feeCents: -1 }],
    [{ ...response, currency: "usd" }],
    [{ ...response, expiresAt: "2026-11-23T11:59:59.000Z" }],
    [{ ...response, unexpected: "untrusted" }],
    [{ ...response, quoteId: "" }],
  ])("rejects malformed, expired, or expanded provider responses", candidate => {
    expect(() => acceptCarrierQuoteResponse(context, candidate, now)).toThrow();
  });

  it("rejects invalid configured providers and server destinations", () => {
    expect(() => acceptCarrierQuoteResponse({ ...context, provider: "https://carrier.test" }, response, now)).toThrow("CARRIER_PROVIDER_INVALID");
    expect(() => acceptCarrierQuoteResponse({ ...context, destination: { ...context.destination, countryCode: "USA" } }, response, now)).toThrow("CARRIER_DESTINATION_INVALID");
  });

  it("invokes the configured adapter and persists only trusted server scope and snapshots", async () => {
    const persisted: unknown[] = [];
    const adapterInput: unknown[] = [];
    const created = await createDurableCarrierQuote({
      tenantId: 14,
      customerId: 28,
      cartFingerprint: context.cartFingerprint,
      destination: context.destination,
    }, {
      provider: context.provider,
      async quote(input) {
        adapterInput.push(input);
        return response;
      },
    }, async value => { persisted.push(value); }, now);

    expect(adapterInput).toEqual([{
      cartFingerprint: context.cartFingerprint,
      destination: context.destination,
      signal: expect.any(AbortSignal),
    }]);
    expect(persisted).toEqual([expect.objectContaining({
      id: created.id,
      tenantId: 14,
      customerId: 28,
      provider: "sandbox_carrier",
      providerQuoteId: "provider-quote-1",
      cartFingerprint: context.cartFingerprint,
      destinationSnapshot: { countryCode: "US", postalCode: "90210", address: "123 Main Street" },
      feeCents: 1299,
      currency: "usd",
      status: "quoted",
      expiresAt: new Date("2026-11-23T12:15:00.000Z"),
    })]);
    expect(created).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^carrier_/),
      feeCents: 1299,
      currency: "usd",
      expiresAt: "2026-11-23T12:15:00.000Z",
    }));
  });

  it("does not persist rejected adapter responses or invalid server scope", async () => {
    const persisted: unknown[] = [];
    const adapter = { provider: context.provider, quote: async () => ({ ...response, feeCents: -1 }) };
    await expect(createDurableCarrierQuote({
      tenantId: 14,
      customerId: 28,
      cartFingerprint: context.cartFingerprint,
      destination: context.destination,
    }, adapter, async value => { persisted.push(value); }, now)).rejects.toThrow("CARRIER_RESPONSE_INVALID");
    await expect(createDurableCarrierQuote({
      tenantId: 0,
      customerId: 28,
      cartFingerprint: context.cartFingerprint,
      destination: context.destination,
    }, adapter, async value => { persisted.push(value); }, now)).rejects.toThrow("CARRIER_SCOPE_INVALID");
    expect(persisted).toEqual([]);
  });

  it("aborts a stalled provider quote and never persists it", async () => {
    const persisted: unknown[] = [];
    let providerSignal: AbortSignal | undefined;
    const adapter = {
      provider: context.provider,
      quote: async (input: { signal: AbortSignal }) => {
        providerSignal = input.signal;
        await new Promise<void>(() => undefined);
      },
    };

    await expect(createDurableCarrierQuote({
      tenantId: 14,
      customerId: 28,
      cartFingerprint: context.cartFingerprint,
      destination: context.destination,
    }, adapter, async value => { persisted.push(value); }, now, 5)).rejects.toThrow("CARRIER_PROVIDER_TIMEOUT");

    expect(providerSignal?.aborted).toBe(true);
    expect(persisted).toEqual([]);
  });
});
