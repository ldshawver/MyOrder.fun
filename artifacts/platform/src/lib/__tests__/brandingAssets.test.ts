import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_BRAND, resolveBranding, visibleSupplierAttribution } from "../branding";

const platformRoot = resolve(import.meta.dirname, "../../..");
const publicRoot = resolve(platformRoot, "public");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const assets: Record<string, string> = {
  "myorder-logo-header.png": "8f463eaf0d48dc2b0bd37a46eee13760fe748a4ea888daee90b06e189336a164",
  "myorder-logo-header.webp": "bc02281e4accad3382cfd76fc80ef62aa034567ad27f99d4983091040dbad90c",
  "myorder-logo-mobile.png": "77c4d21ef3b97be533b1791588abe7bca9bb9bd19b40d224cb768786f595e5a4",
  "favicon-16.png": "6341c833bdb5d2aa2983b942898b8737cba703af4b4bf316f03472770c0cd33f",
  "favicon-32.png": "157027543b8d7eb6b3d37c7594ff30123bfed150067d476b238916f7e84bba8a",
  "favicon-48.png": "fbef9d90863fa52e7593deed3e23f76c8105fa71a771857e1d101e29685c7f5e",
  "apple-touch-icon.png": "5ff965d28b2c38bc6da6119760b71602a675c13900f0c0988c3f7e4335605988",
  "pwa-icon-192.png": "9602ddc4a9e8556bc14cf362767dc134f65542d6c2925da8d86db690a9d34d06",
  "pwa-icon-512.png": "f8b5d47ddd482c2dc06ecc2efb4d6393e74cfd7d8fb37215cf768ebce019312f",
};

describe("MyOrder.fun branding assets", () => {
  it("keeps every optimized derivative present and byte-stable", () => {
    for (const [name, expected] of Object.entries(assets)) {
      const path = resolve(publicRoot, name);
      expect(existsSync(path), name).toBe(true);
      expect(sha256(path), name).toBe(expected);
    }
  });

  it("references the PWA, favicon, and Apple assets from metadata", () => {
    const html = readFileSync(resolve(platformRoot, "index.html"), "utf8");
    const manifest = JSON.parse(readFileSync(resolve(publicRoot, "manifest.webmanifest"), "utf8"));
    // The unauthenticated shell is merchant-facing; the authenticated app
    // updates document.title from the tenant/platform branding context.
    expect(html).toContain("<title>Lucifer Cruz</title>");
    expect(html).toContain('/favicon-32.png');
    expect(html).toContain('/apple-touch-icon.png');
    expect(html).toContain('/manifest.webmanifest');
    expect(manifest.name).toBe("MyOrder.fun");
    expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual(["/pwa-icon-192.png", "/pwa-icon-512.png"]);
  });
});

describe("tenant branding fallback", () => {
  it("uses platform branding for an unbranded tenant", () => {
    const resolved = resolveBranding();
    expect(resolved.customer.displayName).toBe("MyOrder.fun");
    expect(resolved.customer.logoUrl).toBe(PLATFORM_BRAND.logoUrl);
    expect(resolved.customer.faviconUrl).toBe(PLATFORM_BRAND.faviconUrl);
  });

  it("keeps customer and supplier brands separate and hides empty attribution", () => {
    const resolved = resolveBranding({
      customer: { displayName: "Tenant Shop", primaryColor: "#112233" },
      supplier: { displayName: "Example Supplier", attribution: "Fulfilled by Example Supplier", showAttribution: false },
    });
    expect(resolved.customer.displayName).toBe("Tenant Shop");
    expect(resolved.supplier.displayName).toBe("Example Supplier");
    expect(visibleSupplierAttribution(resolved)).toBeNull();
    expect(visibleSupplierAttribution(resolveBranding({ supplier: { attribution: "Configured attribution", showAttribution: true } }))).toBe("Configured attribution");
  });
});

describe("customer-facing default source", () => {
  it("does not expose retired customer-facing branding or disclaimers", () => {
    const files = [
      "index.html", "src/App.tsx", "src/components/layout.tsx", "src/pages/home.tsx",
      "src/pages/pending.tsx", "src/pages/waitlist.tsx", "src/pages/orders.tsx",
      "src/pages/privacy.tsx", "src/pages/terms.tsx", "src/pages/dashboard.tsx",
    ];
    const source = files.map((file) => readFileSync(resolve(platformRoot, file), "utf8")).join("\n");
    expect(source).not.toMatch(/Alavont(?: Therapeutics)?/i);
    expect(source).not.toContain("All transactions are private and discreet.");
    expect(source).not.toContain("Alavont fulfilled by Lucifer Cruz");
    expect(source).not.toContain("Alavont items are sold subject to our standard terms.");
  });
});
