/**
 * Reconciliation coverage for the MyOrder.fun active app navigation cleanup.
 * The platform app does not have a dedicated test runner, so these tests inspect
 * the route/sidebar source directly to guard role visibility, deduped nav items,
 * and removal of unrelated product modules from active MyOrder navigation.
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
const integrationsSrc = src("pages/global-admin/integrations.tsx");

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
    expect(appSrc).toMatch(/\["global_admin", "admin"\]\.includes\(appRole\)[\s\S]*<Route path="\/admin\/settings" component=\{AdminSettingsPage\} \/>/);
    expect(appSrc).toMatch(/\["global_admin", "admin"\]\.includes\(appRole\)[\s\S]*<Route path="\/admin\/receipts" component=\{AdminReceipts\} \/>/);
    expect(appSrc).toMatch(/\["global_admin", "admin"\]\.includes\(appRole\)[\s\S]*<Route path="\/admin\/web-editor" component=\{AdminWebEditor\} \/>/);
    expect(appSrc).toMatch(/\["global_admin", "admin"\]\.includes\(appRole\)[\s\S]*<Route path="\/admin\/visual-editor" component=\{AdminVisualEditor\} \/>/);
    expect(appSrc).toMatch(/\["global_admin", "admin"\]\.includes\(appRole\)[\s\S]*<Route path="\/admin\/roles-permissions" component=\{AdminRolesPermissions\} \/>/);
  });

  it("keeps supervisor and CSR workflows available without granting admin-only routes", () => {
    expect(appSrc).toMatch(/\["global_admin", "admin", "supervisor", "customer_service_rep"\]\.includes\(appRole\)[\s\S]*<Route path="\/staff" component=\{StaffQueue\} \/>/);
    expect(appSrc).toMatch(/\["global_admin", "admin", "supervisor", "customer_service_rep"\]\.includes\(appRole\)[\s\S]*<Route path="\/csr-settings" component=\{CsrSettings\} \/>/);
    expect(layoutSrc).toMatch(/if \(normalized === "supervisor"\) return "supervisor"/);
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

  it("preserves the existing account phone route and user phone input", () => {
    expect(appSrc).toMatch(/<Route path="\/account" component=\{Account\} \/>/);
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
