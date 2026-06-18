/**
 * Reconciliation coverage for the MyOrder.fun active app navigation cleanup.
 * The platform app does not have a dedicated test runner, so these tests inspect
 * the route/sidebar source directly to guard role visibility, deduped nav items,
 * and removal of unrelated product modules from active MyOrder navigation.
 * MyOrder.fun navigation cleanup guards.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const platformRoot = resolve(__dirname, "../../../../platform/src");

function src(relativePath: string): string {
  return readFileSync(resolve(platformRoot, relativePath), "utf8");
}

const appSrc = src("App.tsx");
const layoutSrc = src("components/layout.tsx");
const integrationsSrc = src("pages/global-admin/integrations.tsx");
const routesDir = resolve(__dirname, "..");
const routesIndexSrc = readFileSync(resolve(routesDir, "index.ts"), "utf8");

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("MyOrder active navigation reconciliation", () => {
  it("keeps unrelated product modules out of active App routes and sidebar navigation", () => {
    for (const forbidden of ["SMS & Calls", "Contractor Hub", "Document Hub", "Receipt Templates", "Reprint Receipts"]) {
      expect(appSrc).not.toContain(forbidden);
      expect(layoutSrc).not.toContain(forbidden);
    }
    expect(appSrc).not.toMatch(/<Route path="\/admin\/communications"/);
    expect(appSrc).not.toMatch(/<Route path="\/contractor-hub"/);
    expect(appSrc).not.toMatch(/<Route path="\/document-hub"/);
    expect(layoutSrc).not.toMatch(/href:\s*"\/admin\/communications"/);
    expect(layoutSrc).not.toMatch(/href:\s*"\/contractor-hub"/);
    expect(layoutSrc).not.toMatch(/href:\s*"\/document-hub"/);
  });

  it("keeps current MyOrder admin routes visible to admin/global-admin without supervisor escalation", () => {
    expect(appSrc).toMatch(/normalized === "tenant_admin"[\s\S]*return "admin"/);
    expect(appSrc).toMatch(/if \(normalized === "supervisor"\) return "supervisor"/);
    expect(appSrc).toMatch(/\["global_admin", "admin"\]\.includes\(appRole\)[\s\S]*<Route path="\/admin\/settings">\{\(\) => protect\(<AdminSettingsPage \/>\)\}<\/Route>/);
    expect(appSrc).toMatch(/\["global_admin", "admin"\]\.includes\(appRole\)[\s\S]*<Route path="\/admin\/receipts">\{\(\) => protect\(<AdminReceipts \/>\)\}<\/Route>/);
    expect(appSrc).toMatch(/\["global_admin", "admin"\]\.includes\(appRole\)[\s\S]*<Route path="\/admin\/web-editor" component=\{AdminWebEditor\} \/>/);
    expect(appSrc).toMatch(/\["global_admin", "admin"\]\.includes\(appRole\)[\s\S]*<Route path="\/admin\/visual-editor" component=\{AdminVisualEditor\} \/>/);
    expect(appSrc).toMatch(/\["global_admin", "admin"\]\.includes\(appRole\)[\s\S]*<Route path="\/admin\/roles-permissions">\{\(\) => protect\(<AdminRolesPermissions \/>\)\}<\/Route>/);
  });

  it("keeps supervisor and CSR workflows available without granting admin-only routes", () => {
    expect(appSrc).toMatch(/const isStaff = \["global_admin", "admin", "supervisor", "csr"\]\.includes\(normalizedRole\)/);
    expect(appSrc).toMatch(/isStaff[\s\S]*<Route path="\/staff">\{\(\) => protect\(<StaffQueue \/>\)\}<\/Route>/);
    expect(appSrc).toMatch(/isStaff[\s\S]*<Route path="\/csr-settings" component=\{CsrSettings\} \/>/);
    expect(layoutSrc).toContain("normalizeNotificationRole(user.role)");
    expect(layoutSrc).toMatch(/href:\s*"\/admin\/inventory",\s*label:\s*"Inventory & Par"[\s\S]*roles:\s*SHIFT_ROLES/);
  });

  it("centralizes receipts and printer settings and avoids duplicate nav entries", () => {
    expect(layoutSrc).toContain('label: "Receipts & Printers"');
    expect(layoutSrc).toMatch(/href:\s*"\/admin\/receipts",\s*label:\s*"Receipts & Printers"/);
    expect(countMatches(layoutSrc, /href:\s*"\/admin\/receipts"/g)).toBe(2);
    expect(countMatches(layoutSrc, /label:\s*"Receipts & Printers"/g)).toBe(2);
    expect(countMatches(layoutSrc, /href:\s*"\/global-admin\/integrations"/g)).toBe(1);
  });

  it("keeps global integrations route and sidebar item global-admin only", () => {
    expect(appSrc).toMatch(/appRole === "global_admin"[\s\S]*<Route path="\/global-admin\/integrations" component=\{GlobalAdminIntegrations\} \/>/);
    expect(layoutSrc).toMatch(/title:\s*"Platform Admin",\s*roles:\s*\["global_admin"\]/);
    expect(layoutSrc).toMatch(/href:\s*"\/global-admin\/integrations",\s*label:\s*"Platform Integrations",\s*icon:\s*PlugZap,\s*roles:\s*\["global_admin"\]/);
  });
});

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
    expect(appSrc).not.toContain("public-contract-sign");
    expect(routesIndexSrc).not.toContain("contractor-hub");
    expect(routesIndexSrc).not.toContain("document-hub");
    expect(routesIndexSrc).not.toContain("proposalsRouter");
  });

  it("does not register stale route modules that are absent from the API routes directory", () => {
    expect(existsSync(resolve(routesDir, "communications.ts"))).toBe(false);
    expect(existsSync(resolve(routesDir, "proposals.ts"))).toBe(false);
    expect(routesIndexSrc).not.toContain('from "./communications"');
    expect(routesIndexSrc).not.toContain('from "./proposals"');
    expect(routesIndexSrc).not.toContain("communicationsRouter");
    expect(routesIndexSrc).not.toContain("proposalsRouter");
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
    expect(appSrc).toMatch(/<Route path="\/account">\{\(\) => protect\(<Account \/>\)\}<\/Route>/);
    expect(src("pages/account.tsx")).toMatch(/id="contact-phone"/);
    expect(src("pages/account.tsx")).toMatch(/Mobile Number \(SMS\)/);
  });
});

describe("global admin platform integrations reconciliation", () => {
  it("keeps integration health refresh wired to the existing health endpoint", () => {
    expect(integrationsSrc).toContain('fetch("/api/integrations/health"');
    expect(integrationsSrc).toContain("Refresh health");
  });

  it("includes OAuth, licenses, billing, tenant creation, suspension, and platform settings", () => {
    for (const label of ["External Integrations", "OAuth Apps", "Licenses & Billing", "Tenant Admin", "Platform Settings", "Create Tenant", "Suspend Account"]) {
      expect(integrationsSrc).toContain(label);
    }
    expect(integrationsSrc).toContain("Staging beta · settings forms UI-only until persistence APIs are connected");
  });
});
