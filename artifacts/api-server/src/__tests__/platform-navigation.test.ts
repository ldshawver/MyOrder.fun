import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../../../");
const layoutSource = readFileSync(resolve(repoRoot, "artifacts/platform/src/components/layout.tsx"), "utf8");
const appSource = readFileSync(resolve(repoRoot, "artifacts/platform/src/App.tsx"), "utf8");

const removedLabels = ["Contractor Hub", "Document Hub", "SMS & Calls"];
const removedRoutes = [
  "/contractor-hub",
  "/contractors",
  "/admin/contractor-hub",
  "/document-hub",
  "/admin/document-hub",
  "/sms-calls",
  "/sms-and-calls",
  "/admin/sms-calls",
];

describe("MyOrder.fun platform navigation contract", () => {
  it("does not surface MyPayLink or LUXit modules in the active navigation", () => {
    for (const label of removedLabels) expect(layoutSource).not.toContain(`label: "${label}"`);
  });

  it("keeps supervisor/admin settings and the shared receipt-printer destination in nav", () => {
    expect(layoutSource).toContain('label: "Settings"');
    expect(layoutSource).toContain('href: "/admin/settings"');
    expect(layoutSource).toContain('label: "Receipts & Printers"');
    expect(layoutSource.match(/label: "Receipts & Printers"/g)).toHaveLength(2);
    expect(layoutSource).not.toContain('label: "WooCommerce"');
  });

  it("preserves role-based navigation visibility for the receipt-printer destination", () => {
    expect(layoutSource).toContain('href: "/admin/receipts"');
    expect(layoutSource).toContain('roles: ["global_admin", "admin"]');
    expect(layoutSource).not.toContain('roles: ["supervisor", "csr"]');
  });

  it("does not import or mount active frontend pages for removed modules", () => {
    expect(appSource).not.toMatch(/import .*Contractor/i);
    expect(appSource).not.toMatch(/import .*DocumentHub/i);
    expect(appSource).not.toMatch(/import .*Sms|import .*Calls/i);
  });

  it("has no active direct frontend routes for removed MyPayLink/LUXit modules, so direct URLs fall through to the authorized 404", () => {
    for (const route of removedRoutes) {
      expect(appSource).not.toContain(`path="${route}"`);
    }
    expect(appSource).toContain("<Route component={NotFound} />");
  });
});
