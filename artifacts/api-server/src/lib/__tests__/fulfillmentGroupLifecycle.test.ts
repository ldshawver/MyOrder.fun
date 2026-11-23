import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertStaffMayTransitionFulfillmentGroup,
  deriveParentFulfillmentStatus,
  transitionFulfillmentGroupStatus,
} from "../fulfillmentGroupLifecycle";

describe("fulfillment group lifecycle authority", () => {
  it.each(["alavont", "lucifer_direct"])("allows staff to operate %s groups", (provider) => {
    expect(() => assertStaffMayTransitionFulfillmentGroup(provider)).not.toThrow();
  });

  it("prevents staff from impersonating CJ provider events", () => {
    expect(() => assertStaffMayTransitionFulfillmentGroup("cj")).toThrow(/provider-managed/);
  });

  it("uses the canonical transition graph for group changes", () => {
    expect(transitionFulfillmentGroupStatus("submitted", "in_progress")).toMatchObject({ to: "in_progress" });
    expect(() => transitionFulfillmentGroupStatus("submitted", "completed")).toThrow();
  });

  it.each([
    [["submitted", "completed"], "preparing"],
    [["in_progress", "submitted"], "in_progress"],
    [["ready", "completed"], "ready"],
    [["completed", "cancelled"], "completed"],
    [["cancelled", "cancelled"], "cancelled"],
    [["ready", "reconciliation_required"], "reconciliation_required"],
  ] as const)("derives %s as %s", (groups, expected) => {
    expect(deriveParentFulfillmentStatus(groups)).toBe(expected);
  });

  it("binds the staff route to tenant/order/group scope, locking, parent derivation, and audit", () => {
    const route = readFileSync(new URL("../../routes/orders.ts", import.meta.url), "utf8");
    expect(route).toContain('router.patch("/orders/:id/fulfillment-groups/:groupId/status"');
    expect(route).toContain('assertStaffMayTransitionFulfillmentGroup(group.provider)');
    expect(route).toContain('.for("update").limit(1)');
    expect(route).toContain('deriveParentFulfillmentStatus(groups.map');
    expect(route).toContain('await tx.insert(auditLogsTable).values({');
    expect(route).toContain('action: "UPDATE_FULFILLMENT_GROUP_STATUS", tenantId');
    expect(route).toContain('Grouped orders must be advanced through a fulfillment group');
  });
});
