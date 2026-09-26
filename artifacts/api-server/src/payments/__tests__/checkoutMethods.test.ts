import { describe, expect, it } from "vitest";
import { checkoutPaymentMethods } from "../checkoutMethods";

describe("checkout payment availability", () => {
  it("shows Cash only when tenant settings enable it", () => {
    expect(checkoutPaymentMethods(["cash"], false).find(method => method.id === "cash")?.available).not.toBe(false);
    expect(checkoutPaymentMethods(["paypal"], false).some(method => method.id === "cash")).toBe(false);
  });

  it("allows PayPal only when both tenant settings and provider configuration are enabled", () => {
    expect(checkoutPaymentMethods(["paypal"], true).find(method => method.id === "paypal")?.available).toBe(true);
    expect(checkoutPaymentMethods(["paypal"], false).find(method => method.id === "paypal")?.available).toBe(false);
    expect(checkoutPaymentMethods(["cash"], true).some(method => method.id === "paypal")).toBe(false);
  });
});
