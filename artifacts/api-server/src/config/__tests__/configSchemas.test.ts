import { describe, it, expect } from "vitest";
import { createBusinessSettingsPatchSchema } from "../configSchemas";

const productionSchema = createBusinessSettingsPatchSchema({ runtimeEnvironment: "production" });
const developmentSchema = createBusinessSettingsPatchSchema({ runtimeEnvironment: "development" });

describe("business settings schema", () => {
  it("accepts a valid minimal USD business patch", () => {
    expect(productionSchema.safeParse({ version: 1, publicBusinessName: "Acme", timezone: "America/Los_Angeles", defaultCurrency: "USD", websiteUrl: "https://example.com", storefrontUrl: "https://shop.example.com/path" }).success).toBe(true);
    expect(developmentSchema.safeParse({ version: 1, websiteUrl: "http://localhost:3000", storefrontUrl: "http://127.0.0.1:3000/dev" }).success).toBe(true);
    expect(developmentSchema.safeParse({ version: 1, websiteUrl: "http://[::1]:3000/dev" }).success).toBe(true);
  });

  it("rejects unknown root and address fields", () => {
    expect(productionSchema.safeParse({ version: 1, role: "admin" }).success).toBe(false);
    expect(productionSchema.safeParse({ version: 1, businessAddress: { line1: "1 Main", tenantId: 2 } }).success).toBe(false);
  });

  it("rejects unsafe URLs", () => {
    const longLabel = "a".repeat(64);
    const longHostname = `${Array.from({ length: 40 }, () => "aaaaaa").join(".")}.com`;
    for (const websiteUrl of [
      "javascript:alert(1)",
      "data:text/html,test",
      "file:///etc/passwd",
      "ftp://example.com",
      "https://user:password@example.com",
      "https://bad_host.example",
      "https://-bad.example",
      "https://bad-.example",
      "https://bad..example",
      `https://${longLabel}.example.com`,
      `https://${longHostname}`,
      "http://example.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://[::1]",
      "https://example.com/\u0001",
      "https://example.com/\0",
      "https://internal",
      "https://printer.local",
      "https://service.internal",
    ]) {
      expect(productionSchema.safeParse({ version: 1, websiteUrl }).success, websiteUrl).toBe(false);
    }
  });

  it("rejects invalid email, timezone, currencies, oversized names, and HTML", () => {
    expect(productionSchema.safeParse({ version: 1, supportEmail: "not-email" }).success).toBe(false);
    expect(productionSchema.safeParse({ version: 1, timezone: "Fake/Zone" }).success).toBe(false);
    expect(productionSchema.safeParse({ version: 1, defaultCurrency: "usd" }).success).toBe(false);
    expect(productionSchema.safeParse({ version: 1, defaultCurrency: "EUR" }).success).toBe(false);
    expect(productionSchema.safeParse({ version: 1, appName: "x".repeat(81) }).success).toBe(false);
    expect(productionSchema.safeParse({ version: 1, businessDescription: "<script>alert(1)</script>" }).success).toBe(false);
  });
});
