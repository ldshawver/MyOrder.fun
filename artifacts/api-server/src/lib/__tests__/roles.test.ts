import { describe, expect, it } from "vitest";
import { defaultHasPermission, normalizeRole } from "../roles";

describe("role normalization", () => {
  it.each([
    ["customer", "user"],
    ["customer_service_rep", "csr"],
    ["manager", "admin"],
    ["tenant_admin", "admin"],
    ["super_admin", "global_admin"],
    ["platform_admin", "global_admin"],
    ["unknown", "user"],
  ])("maps %s to %s", (input, expected) => expect(normalizeRole(input)).toBe(expected));
});

describe("default permissions", () => {
  it("keeps tenant settings away from supervisor", () => {
    expect(defaultHasPermission("supervisor", "settings.manage_tenant")).toBe(false);
  });
  it("allows admins to manage tenant permissions but not platform permissions", () => {
    expect(defaultHasPermission("admin", "users.manage_permissions")).toBe(true);
    expect(defaultHasPermission("admin", "platform.tenants.manage")).toBe(false);
  });
  it("allows global admins to edit all permissions", () => {
    expect(defaultHasPermission("global_admin", "platform.global_settings.manage")).toBe(true);
  });
  it("does not allow csr role management", () => {
    expect(defaultHasPermission("csr", "users.manage_roles")).toBe(false);
  });
});
