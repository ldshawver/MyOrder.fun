import { describe, expect, it } from "vitest";
import { loadPaymentConfig, PaymentConfigurationError } from "../config";

const sandbox = { NODE_ENV: "staging", PAYMENT_PROVIDER: "paypal", PAYMENT_MODE: "sandbox", PAYPAL_ENVIRONMENT: "sandbox", PAYPAL_CLIENT_ID: "sandbox-client", PAYPAL_CLIENT_SECRET: "sandbox-secret", PAYPAL_WEBHOOK_ID: "sandbox-webhook" };

describe("payment configuration safety", () => {
  it("fails closed to disabled when payment configuration is absent", () => expect(loadPaymentConfig({})).toEqual({ mode: "disabled", provider: "paypal", enabled: false }));
  it("accepts complete PayPal Sandbox configuration", () => expect(loadPaymentConfig(sandbox).enabled).toBe(true));
  it("rejects live mode in staging", () => expect(() => loadPaymentConfig({ ...sandbox, PAYMENT_MODE: "live", PAYPAL_ENVIRONMENT: "live" })).toThrow(/Staging/));
  it("rejects live mode outside production", () => expect(() => loadPaymentConfig({ ...sandbox, NODE_ENV: "development", PAYMENT_MODE: "live", PAYPAL_ENVIRONMENT: "live" })).toThrow(/production/));
  it("rejects missing credentials", () => expect(() => loadPaymentConfig({ ...sandbox, PAYPAL_CLIENT_SECRET: "" })).toThrow(PaymentConfigurationError));
  it("rejects contradictory mode and environment", () => expect(() => loadPaymentConfig({ ...sandbox, PAYPAL_ENVIRONMENT: "live" })).toThrow(/match/));
  it("rejects configurable provider API origins", () => expect(() => loadPaymentConfig({ ...sandbox, PAYPAL_API_BASE_URL: "https://example.invalid" })).toThrow(/not configurable/));
  it("rejects credentials in disabled mode", () => expect(() => loadPaymentConfig({ ...sandbox, PAYMENT_MODE: "disabled" })).toThrow(/absent/));
  it("rejects Stripe as a provider", () => expect(() => loadPaymentConfig({ PAYMENT_MODE: "disabled", PAYMENT_PROVIDER: "stripe" })).toThrow(/paypal/));
});
