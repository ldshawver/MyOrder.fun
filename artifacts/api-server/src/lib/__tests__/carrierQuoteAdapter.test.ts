import { describe, expect, it } from "vitest";
import { acceptCarrierQuoteResponse } from "../carrierQuoteAdapter";

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
});
