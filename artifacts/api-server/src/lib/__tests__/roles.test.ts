import { describe, expect, it } from "vitest";
import { defaultHasPermission, normalizeRole, CANONICAL_ROLES } from "../roles";

describe("canonical role definitions", () => {
  it("contains only the approved canonical roles", () => {
    expect(CANONICAL_ROLES).toEqual(["user", "csr", "supervisor", "admin", "global_admin"]);
  });
});

describe("role normalization", () => {
  it.each([
    ["customer_service_rep", "csr"],
    ["csr", "csr"],
    ["supervisor", "supervisor"],
    ["admin", "admin"],
    ["tenant_admin", "admin"],
    ["manager", "admin"],
    ["global-admin", "global_admin"],
    ["super_admin", "global_admin"],
    ["unknown", "user"],
    [null, "user"],
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
    expect(defaultHasPermission("csr", "queue.view")).toBe(true);
    expect(defaultHasPermission("csr", "queue.claim")).toBe(true);
    expect(defaultHasPermission("csr", "cash_sessions.join")).toBe(true);
    expect(defaultHasPermission("csr", "cash_closeout.own")).toBe(true);
    expect(defaultHasPermission("csr", "queue.manage")).toBe(false);
    expect(defaultHasPermission("csr", "cash_closeout.override")).toBe(false);
  });
  it("allows supervisors to manage General Queue cash sessions without tenant settings access", () => {
    expect(defaultHasPermission("supervisor", "settings.manage_tenant")).toBe(false);
    expect(defaultHasPermission("supervisor", "queue.manage")).toBe(true);
    expect(defaultHasPermission("supervisor", "cash_sessions.manage")).toBe(true);
    expect(defaultHasPermission("supervisor", "cash_closeout.override")).toBe(true);
  });
});
