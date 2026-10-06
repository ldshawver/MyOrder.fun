import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canAccessStaffRoute } from "../routingPolicy";
import { assignableRolesForActor, canAssignRoleFromUserManagement } from "../userManagementPolicy";

describe("staff route policy", () => {
  it.each(["supervisor", "csr"])("renders /staff for canonical %s", (role) => {
    expect(canAccessStaffRoute(role)).toBe(true);
  });

  it.each(["user", undefined, "unknown"])("denies /staff for unauthorized role %s", (role) => {
    expect(canAccessStaffRoute(role)).toBe(false);
  });

  it("registers /staff directly before role-specific route fragments", () => {
    const app = readFileSync(resolve(import.meta.dirname, "../../App.tsx"), "utf8");
    const staffRoute = app.indexOf('{isStaff && <Route path="/staff">');
    const adminFragment = app.indexOf('{["global_admin", "admin"].includes(appRole) && (');
    const supervisorFragment = app.indexOf('{appRole === "supervisor" && (');
    expect(staffRoute).toBeGreaterThan(-1);
    expect(staffRoute).toBeLessThan(adminFragment);
    expect(staffRoute).toBeLessThan(supervisorFragment);
    expect(app.match(/<Route path="\/staff"/g)).toHaveLength(1);
  });
});

describe("supervisor user-management policy", () => {
  it("offers only user and csr assignments", () => {
    expect(assignableRolesForActor("supervisor")).toEqual(["user", "csr"]);
    expect(canAssignRoleFromUserManagement("supervisor", "admin")).toBe(false);
    expect(canAssignRoleFromUserManagement("supervisor", "supervisor")).toBe(false);
  });
});
