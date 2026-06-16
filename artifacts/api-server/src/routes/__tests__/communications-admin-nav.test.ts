/**
 * MyOrder.fun navigation cleanup guards.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const platformRoot = resolve(__dirname, "../../../../platform/src");

function src(relativePath: string): string {
  return readFileSync(resolve(platformRoot, relativePath), "utf8");
}

const appSrc = src("App.tsx");
const layoutSrc = src("components/layout.tsx");

describe("MyOrder.fun navigation cleanup", () => {
  it("removes LUXit communications navigation and direct app routes", () => {
    expect(layoutSrc).not.toContain("SMS & Calls");
    expect(layoutSrc).not.toContain("Phone & SMS");
    expect(layoutSrc).not.toContain('href: "/admin/communications"');
    expect(layoutSrc).not.toContain('href: "/communications"');
    expect(appSrc).not.toContain('path="/admin/communications"');
    expect(appSrc).not.toContain('path="/communications"');
  });

  it("removes MyPayLink document and contractor hub navigation and routes", () => {
    expect(layoutSrc).not.toContain("Document Hub");
    expect(layoutSrc).not.toContain("Contractor Hub");
    expect(appSrc).not.toContain('path="/document-hub"');
    expect(appSrc).not.toContain('path="/contractor-hub"');
    expect(appSrc).not.toContain('path="/app/contractor-hub/contracts/:id/sign"');
  });

  it("uses Settings and centralized Receipts & Printers navigation", () => {
    expect(layoutSrc).toContain('label: "Settings"');
    expect(layoutSrc).toContain('label: "Receipts & Printers"');
    expect(layoutSrc).not.toContain('label: "WooCommerce"');
    expect(layoutSrc).not.toContain('label: "Integrations"');
    expect(layoutSrc).not.toContain('label: "Receipt Templates"');
    expect(layoutSrc).not.toContain('label: "Reprint Receipts"');
  });

  it("keeps existing PWA/account phone settings separate from removed app communications modules", () => {
    expect(appSrc).toMatch(/<Route path="\/account" component=\{Account\} \/>/);
    expect(src("pages/account.tsx")).toMatch(/id="contact-phone"/);
    expect(src("pages/account.tsx")).toMatch(/Mobile Number \(SMS\)/);
  });
});
