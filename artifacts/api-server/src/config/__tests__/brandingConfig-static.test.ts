import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(new URL("../brandingConfig.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../../routes/tenant-settings.ts", import.meta.url), "utf8");
const roles = readFileSync(new URL("../../lib/roles.ts", import.meta.url), "utf8");

describe("tenant branding foundation", () => {
  it("stores branding inside the existing tenant-scoped settings envelope without a tenant id constant", () => {
    expect(service).toContain("settings.branding");
    expect(service).toContain("tenantId: number");
    expect(service).not.toMatch(/HOUSE_TENANT_ID|tenantId\s*=\s*1/);
  });

  it("requires authenticated tenant scope, server permission, and audit logging", () => {
    expect(routes).toContain('router.patch("/settings/branding"');
    expect(routes).toContain('hasPermission(req.dbUser, "settings.edit_business", tenantId)');
    expect(routes).toContain('action: "tenant_settings.branding_updated"');
    expect(routes).not.toContain("req.body.tenantId");
  });

  it("keeps platform permissions unavailable to tenant admin and manager aliases", () => {
    expect(roles).toContain('manager: ROLE_ADMIN');
    expect(roles).toContain('if (PLATFORM_PERMISSIONS.includes(permission as Permission)) return false');
  });
});
