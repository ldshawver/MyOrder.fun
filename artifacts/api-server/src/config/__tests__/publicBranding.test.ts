import { describe, expect, it } from "vitest";
import { normalizeStorefrontHost, resolvePublicBrandingForHost, type StorefrontBrandingRecord } from "../publicStorefrontBranding";

const lucifer: StorefrontBrandingRecord = {
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
});
