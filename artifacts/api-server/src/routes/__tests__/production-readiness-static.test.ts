import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");
const api = (name: string) => readFileSync(join(root, "routes", name), "utf8");
const page = (name: string) => readFileSync(join(root, "../../platform/src/pages", name), "utf8");
const component = (name: string) => readFileSync(join(root, "../../platform/src/components", name), "utf8");

describe("production readiness workflow coverage", () => {
  it("uses one canonical role-permissions router with legacy import compatibility", () => {
    expect(api("permissions.ts")).toContain('export { default } from "./role-permissions"');
    expect(api("role-permissions.ts")).toContain('requirePermission("users.manage_permissions")');
    expect(api("role-permissions.ts")).toContain("z.array(z.object({ permission: permissionEnum, enabled: z.boolean() })");
  });

  it("exposes store-credit checkout UI states and cash closeout controls", () => {
    const orderDetail = page("order-detail.tsx");
    for (const text of ["Apply Customer Credit", "Remaining Balance", "Partial Customer Credit", "Full Customer Credit", "Close as Cash Paid"]) {
      expect(orderDetail).toContain(text);
    }
    expect(orderDetail).toContain('/api/payments/${order.id}/apply-credit');
    expect(orderDetail).toContain('/api/orders/${order.id}/closeout');
  });

  it("exposes feedback outcome/status/result text in self-service history", () => {
    const profile = page("profile.tsx");
    expect(profile).toContain("Status / Result / Outcome");
    expect(profile).toContain("Public outcome notes");
    expect(profile).toContain("/api/feedback?mine=true");
  });

  it("keeps CSR order claim, complete, and receipt/label print controls wired", () => {
    const staff = page("staff.tsx");
    expect(staff).toContain('/api/orders/${order.id}/claim');
    expect(staff).toContain('/api/orders/${order.id}/complete');
    expect(staff).toContain('/api/print/orders/${order.id}/receipt');
    expect(staff).toContain('/api/print/orders/${order.id}/label');
  });

  it("keeps backend cash closeout and stale archive endpoints available", () => {
    const orders = api("orders.ts");
    expect(orders).toContain('paymentMethod: z.literal("cash")');
    expect(orders).toContain("generalQueueCashSessionsTable");
    expect(orders).toContain('/orders/:id/closeout');
    expect(orders).toContain('/admin/orders/stale-submitted/archive');
    expect(orders).toContain('ORDER_STALE_SUBMITTED_ARCHIVED');
  });

  it("renders mutually exclusive authoritative queue states for supervisors and managers", () => {
    const layout = component("layout.tsx");
    const queue = api("shift-queue.ts");
    expect(layout).toContain('["global_admin", "admin", "supervisor"].includes(userRole)');
    expect(layout).toContain("General Queue Active");
    expect(layout).toContain("Active CSR");
    expect(layout).toContain("View General Queue");
    expect(layout).toContain("View Shift/Queue");
    expect(layout).toContain("/api/shift-queue/status");
    expect(queue).toContain(': "General Queue Active"');
    expect(queue).toContain("activeCsr:");
  });
});
