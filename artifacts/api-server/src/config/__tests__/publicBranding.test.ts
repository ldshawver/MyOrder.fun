import { describe, expect, it } from "vitest";
import { normalizeStorefrontHost, resolvePublicBrandingForHost, resolveStagingPublicBrandingAlias, type StorefrontBrandingRecord } from "../publicStorefrontBranding";

const lucifer: StorefrontBrandingRecord = {
  tenantId: 1,
  storefrontUrl: "https://shop.lucifercruz.com/",
  publicBusinessName: "Lucifer Cruz",
  businessDescription: "Bold, discreet, and unapologetically adult.",
  settings: { branding: { customer: {
    displayName: "Lucifer Cruz",
    logoUrl: "/lc-logo.webp",
    faviconUrl: "/lc-favicon.png",
    primaryColor: "#820000",
    secondaryColor: "#C0C0C0",
    supportEmail: "support@example.test",
    secret: "must never be returned",
  } } },
};

const other: StorefrontBrandingRecord = {
  tenantId: 2,
  storefrontUrl: "https://store.example.test/",
  publicBusinessName: "Other Store",
  businessDescription: "Other storefront.",
  settings: { branding: { customer: { displayName: "Other Store", logoUrl: "/other.png", primaryColor: "#123456" } } },
};

describe("public storefront branding", () => {
  it("uses only exact normalized configured storefront hosts", () => {
    expect(normalizeStorefrontHost("SHOP.LUCIFERCRUZ.COM:443")).toBe("shop.lucifercruz.com");
    expect(resolvePublicBrandingForHost("shop.lucifercruz.com", [lucifer, other])?.customer.displayName).toBe("Lucifer Cruz");
    expect(resolvePublicBrandingForHost("store.example.test", [lucifer, other])?.customer.displayName).toBe("Other Store");
    expect(resolvePublicBrandingForHost("evil-shop.lucifercruz.com", [lucifer, other])).toBeNull();
    expect(resolvePublicBrandingForHost("shop.lucifercruz.com", [lucifer, { ...other, storefrontUrl: "https://shop.lucifercruz.com" }])).toBeNull();
  });

  it("rejects malformed host input and does not use forwarding syntax", () => {
    for (const value of ["shop.lucifercruz.com, evil.test", "https://shop.lucifercruz.com", "shop.lucifercruz.com/path", "shop.lucifercruz.com:3000", "bad host"]) {
      expect(normalizeStorefrontHost(value)).toBeNull();
    }
  });

  it("returns only the public presentation allowlist", () => {
    const result = resolvePublicBrandingForHost("shop.lucifercruz.com", [lucifer]);
    expect(result).toEqual({ customer: expect.objectContaining({ displayName: "Lucifer Cruz", primaryColor: "#820000" }) });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toMatch(/tenantId|clerk|payment|printer/i);
  });

  it("permits an exact, server-configured staging alias without replacing the canonical storefront domain", () => {
    const config = { runtimeEnvironment: "staging", host: "staging.myorder.fun", tenantId: "1" };
    expect(resolveStagingPublicBrandingAlias("staging.myorder.fun", [lucifer, other], config)?.customer.displayName).toBe("Lucifer Cruz");
    expect(resolvePublicBrandingForHost("shop.lucifercruz.com", [lucifer, other])?.customer.displayName).toBe("Lucifer Cruz");
    expect(resolveStagingPublicBrandingAlias("other.example.test", [lucifer, other], config)).toBeNull();
    expect(resolveStagingPublicBrandingAlias("staging.myorder.fun", [lucifer, other], { ...config, tenantId: "2" })?.customer.displayName).toBe("Other Store");
  });

  it("fails closed when the alias is incomplete, malformed, or outside staging", () => {
    expect(resolveStagingPublicBrandingAlias("staging.myorder.fun", [lucifer], { runtimeEnvironment: "production", host: "staging.myorder.fun", tenantId: "1" })).toBeNull();
    expect(resolveStagingPublicBrandingAlias("staging.myorder.fun", [lucifer], { runtimeEnvironment: "staging", host: "staging.myorder.fun/path", tenantId: "1" })).toBeNull();
    expect(resolveStagingPublicBrandingAlias("staging.myorder.fun", [lucifer], { runtimeEnvironment: "staging", host: "staging.myorder.fun", tenantId: undefined })).toBeNull();
  });
});
