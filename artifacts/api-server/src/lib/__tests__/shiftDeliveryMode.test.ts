import { describe, expect, it } from "vitest";
import { resolveCustomerFulfillment, shiftDeliveryMode } from "../shiftDeliveryMode";

describe("shift delivery mode", () => {
  it("reads the shift choice and falls back to a personal opt-in", () => {
    expect(shiftDeliveryMode({ setupJson: { deliveryMode: "uber" }, csrDeliveryOptIn: true })).toBe("uber");
    expect(shiftDeliveryMode({ setupJson: { deliveryMode: "personal" } })).toBe("personal");
    expect(shiftDeliveryMode({ csrDeliveryOptIn: true })).toBe("personal");
    expect(shiftDeliveryMode({ csrDeliveryOptIn: false })).toBeNull();
  });

  it("lets the customer choose pickup or delivery, and the shift chooses the delivery style", () => {
    expect(resolveCustomerFulfillment("pickup", "uber")).toEqual({ method: "pickup" });
    expect(resolveCustomerFulfillment("uber_direct", "personal")).toEqual({ method: "csr_delivery" });
    expect(resolveCustomerFulfillment("csr_delivery", "uber")).toEqual({ method: "uber_direct" });
    expect(resolveCustomerFulfillment("manual_delivery", "uber")).toEqual({ method: "uber_direct" });
    expect(resolveCustomerFulfillment("delivery", null)).toEqual({ error: "Delivery is set by the specialist on shift. Pickup is available." });
  });
});
