import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE_PERMISSIONS, PLATFORM_PERMISSIONS, defaultHasPermission, normalizeRole } from "./roles";

describe("role normalization", () => {
  it.each([
    ["customer", "user"],
    ["normal_user", "user"],
    ["customer_service_rep", "csr"],
    ["manager", "admin"],
    ["tenant_admin", "admin"],
    ["super_admin", "global_admin"],
    ["platform_admin", "global_admin"],
    ["mystery", "user"],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeRole(input)).toBe(expected);
  });
});

describe("default role permission matrix", () => {
  it("keeps users away from admin settings", () => {
    expect(defaultHasPermission("user", "settings.manage_tenant")).toBe(false);
    expect(defaultHasPermission("user", "users.manage_roles")).toBe(false);
  });

  it("keeps csr from role management", () => {
    expect(defaultHasPermission("csr", "users.manage_roles")).toBe(false);
  });

  it("keeps supervisor from tenant settings", () => {
    expect(defaultHasPermission("supervisor", "settings.manage_tenant")).toBe(false);
  });

  it("allows admin tenant role/permission management but no platform permissions", () => {
    expect(defaultHasPermission("admin", "users.manage_roles")).toBe(true);
    expect(defaultHasPermission("admin", "users.manage_permissions")).toBe(true);
    for (const permission of PLATFORM_PERMISSIONS) expect(defaultHasPermission("admin", permission)).toBe(false);
  });

  it("allows global admin all permissions", () => {
    for (const permission of Object.values(DEFAULT_ROLE_PERMISSIONS.global_admin)) {
      expect(defaultHasPermission("global_admin", permission)).toBe(true);
    }
    expect(defaultHasPermission("global_admin", "platform.tenants.manage")).toBe(true);
  });
});
