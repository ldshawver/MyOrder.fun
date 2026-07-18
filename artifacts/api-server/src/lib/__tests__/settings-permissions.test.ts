import { describe, expect, it } from "vitest";
import { defaultHasPermission } from "../roles";

describe("Phase 2A settings role permissions", () => {
  it("allows only tenant admins and global admins to edit business settings by default", () => {
    expect(defaultHasPermission("user", "settings.edit_business")).toBe(false);
    expect(defaultHasPermission("csr", "settings.edit_business")).toBe(false);
    expect(defaultHasPermission("supervisor", "settings.edit_business")).toBe(false);
    expect(defaultHasPermission("admin", "settings.edit_business")).toBe(true);
    expect(defaultHasPermission("global_admin", "settings.edit_business")).toBe(true);
  });

  it("allows supervisors to view settings without granting edit", () => {
    expect(defaultHasPermission("supervisor", "settings.view")).toBe(true);
    expect(defaultHasPermission("supervisor", "settings.edit_business")).toBe(false);
  });
});
