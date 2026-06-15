/**
 * Reconciliation coverage for the admin communications + global integrations UI.
 * The platform app does not have a dedicated test runner, so these tests inspect
 * the route/sidebar source directly to guard role visibility and avoid duplicate
 * additions while preserving existing PWA/account phone routes.
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
const communicationsSrc = src("pages/admin/communications.tsx");
const integrationsSrc = src("pages/global-admin/integrations.tsx");

describe("communications admin reconciliation", () => {
  it("registers /admin/communications for admin/global-admin route visibility", () => {
    expect(appSrc).toMatch(/import AdminCommunications from "@\/pages\/admin\/communications"/);
    expect(appSrc).toMatch(/\["global_admin", "admin"\]\.includes\(normalizeNotificationRole\(user\.role\)\)[\s\S]*<Route path="\/admin\/communications" component=\{AdminCommunications\} \/>/);
  });

  it("keeps SMS & Calls in supervisor nav for admin-equivalent roles without duplicate nav entries", () => {
    expect(layoutSrc).toMatch(/href:\s*"\/admin\/communications",\s*label:\s*"SMS & Calls",\s*icon:\s*Phone,\s*roles:\s*\["global_admin", "admin"\]/);
    expect(layoutSrc).toMatch(/if \(role === "admin" \|\| role === "supervisor"\) return "admin"/);
    const matches = layoutSrc.match(/href:\s*"\/admin\/communications"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("keeps global integrations route and sidebar item global-admin only", () => {
    expect(appSrc).toMatch(/normalizeNotificationRole\(user\.role\) === "global_admin"[\s\S]*<Route path="\/global-admin\/integrations" component=\{GlobalAdminIntegrations\} \/>/);
    expect(layoutSrc).toMatch(/title:\s*"Platform Admin",\s*roles:\s*\["global_admin"\]/);
    expect(layoutSrc).toMatch(/href:\s*"\/global-admin\/integrations",\s*label:\s*"Platform Integrations",\s*icon:\s*PlugZap,\s*roles:\s*\["global_admin"\]/);
    const matches = layoutSrc.match(/href:\s*"\/global-admin\/integrations"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("preserves the existing PWA/account phone route and user phone input", () => {
    expect(appSrc).toMatch(/<Route path="\/account" component=\{Account\} \/>/);
    expect(src("pages/account.tsx")).toMatch(/id="contact-phone"/);
    expect(src("pages/account.tsx")).toMatch(/Mobile Number \(SMS\)/);
  });

  it("includes tenant/company and number filtering controls", () => {
    expect(communicationsSrc).toMatch(/const \[companyFilter, setCompanyFilter\]/);
    expect(communicationsSrc).toMatch(/const \[numberFilter, setNumberFilter\]/);
    expect(communicationsSrc).toMatch(/entry\.company !== companyFilter/);
    expect(communicationsSrc).toMatch(/entry\.number !== numberFilter/);
    expect(communicationsSrc).toMatch(/All companies/);
    expect(communicationsSrc).toMatch(/All numbers/);
  });

  it("keeps requested communications tabs and UI-only disclosure for unwired pieces", () => {
    for (const label of ["SMS Settings", "SMS Campaigns", "Call Settings", "Numbers & Permissions", "Call Log", "Voicemail"]) {
      expect(communicationsSrc).toContain(label);
    }
    expect(communicationsSrc).toContain("Auto Reply Rules");
    expect(communicationsSrc).toContain("Timed forwarding");
    expect(communicationsSrc).toContain("Missed call escalation");
    expect(communicationsSrc).toContain("Staging beta · UI-only shell pending communications APIs");
  });

  it("includes call-log filters and voicemail inbox actions", () => {
    for (const value of ["made", "received", "missed", "voicemail"]) {
      expect(communicationsSrc).toMatch(new RegExp(`SelectItem value="${value}"`));
    }
    for (const action of ["Assign", "Mark resolved", "Archive"]) {
      expect(communicationsSrc).toContain(action);
    }
    expect(communicationsSrc).toMatch(/<Play size=\{14\}/);
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
