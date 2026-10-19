import { afterEach, describe, expect, it } from "vitest";
import { assertWooCommerceExternalIntegrationPolicy, isWooCommerceExternalIntegrationEnabled, WOO_EXTERNAL_INTEGRATION_ENV } from "../wooExternalPolicy";

const priorNodeEnv = process.env.NODE_ENV;
const priorPolicy = process.env[WOO_EXTERNAL_INTEGRATION_ENV];

afterEach(() => {
  if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = priorNodeEnv;
  if (priorPolicy === undefined) delete process.env[WOO_EXTERNAL_INTEGRATION_ENV];
  else process.env[WOO_EXTERNAL_INTEGRATION_ENV] = priorPolicy;
});

describe("WooCommerce external integration policy", () => {
  it("fails closed for outbound operations unless the policy is explicitly true", () => {
    process.env.NODE_ENV = "staging";
    process.env[WOO_EXTERNAL_INTEGRATION_ENV] = "false";
    expect(isWooCommerceExternalIntegrationEnabled()).toBe(false);
    process.env[WOO_EXTERNAL_INTEGRATION_ENV] = "true";
    expect(isWooCommerceExternalIntegrationEnabled()).toBe(true);
    delete process.env[WOO_EXTERNAL_INTEGRATION_ENV];
    expect(isWooCommerceExternalIntegrationEnabled()).toBe(false);
  });

  it("requires explicit staging policy and rejects unknown values", () => {
    process.env.NODE_ENV = "staging";
    delete process.env[WOO_EXTERNAL_INTEGRATION_ENV];
    expect(() => assertWooCommerceExternalIntegrationPolicy()).toThrow(/explicitly set/);
    process.env[WOO_EXTERNAL_INTEGRATION_ENV] = "no";
    expect(() => assertWooCommerceExternalIntegrationPolicy()).toThrow(/explicitly set/);
    process.env[WOO_EXTERNAL_INTEGRATION_ENV] = "false";
    expect(() => assertWooCommerceExternalIntegrationPolicy()).not.toThrow();
    process.env[WOO_EXTERNAL_INTEGRATION_ENV] = "true";
    expect(() => assertWooCommerceExternalIntegrationPolicy()).not.toThrow();
  });

  it("requires an explicit boolean policy in production and permits fail-closed disablement", () => {
    process.env.NODE_ENV = "production";
    delete process.env[WOO_EXTERNAL_INTEGRATION_ENV];
    expect(() => assertWooCommerceExternalIntegrationPolicy()).toThrow(/explicitly set/);
    process.env[WOO_EXTERNAL_INTEGRATION_ENV] = "false";
    expect(() => assertWooCommerceExternalIntegrationPolicy()).not.toThrow();
    expect(isWooCommerceExternalIntegrationEnabled()).toBe(false);
    process.env[WOO_EXTERNAL_INTEGRATION_ENV] = "true";
    expect(() => assertWooCommerceExternalIntegrationPolicy()).not.toThrow();
    expect(isWooCommerceExternalIntegrationEnabled()).toBe(true);
  });
});
