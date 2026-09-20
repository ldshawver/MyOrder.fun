import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UberDirectConfigError, normalizeUberAddress, verifyUberWebhookSignature } from "../uberDirect";

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
});
