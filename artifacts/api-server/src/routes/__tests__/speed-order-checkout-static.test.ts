import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const orders = readFileSync(new URL("../orders.ts", import.meta.url), "utf8");
const speedOrder = readFileSync(new URL("../speed-order.ts", import.meta.url), "utf8");

describe("Speed Order member checkout boundary", () => {
  it("scopes approval middleware so customer checkout routes are not intercepted", () => {
    expect(speedOrder).toContain('router.use("/speed-order", requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext)');
    expect(speedOrder).not.toContain("router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext)");
  });

  it("requires Speed Order and customer-view permissions before delegation", () => {
    expect(orders).toContain('hasPermission(staff, "speed_order.use", tenantId)');
    expect(orders).toContain('hasPermission(staff, "customers.view", tenantId)');
  });

  it("limits checkout ownership to an eligible customer in the actor tenant", () => {
    expect(orders).toContain("eq(usersTable.tenantId, tenantId)");
    expect(orders).toContain('eq(usersTable.status, "approved")');
    expect(orders).toContain("eq(usersTable.isActive, true)");
    expect(orders).toContain("lower(${usersTable.role}) IN ('user', 'customer')");
  });

  it("retains the authenticated staff actor for an explicit order audit", () => {
    expect(orders).toContain("speedOrderStaffActors.set(req, staff)");
    expect(orders).toContain('action: "SPEED_ORDER_CREATED"');
    expect(orders).toContain("metadata: { customerId: actor.id");
  });
});
