import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../shifts.ts"), "utf8");

describe("supervisor/admin CSR shift controls", () => {
  it("exposes privileged reassignment and termination controls", () => {
    expect(source).toContain('router.post("/shifts/:id/reassign", requireRole("global_admin", "admin", "supervisor")');
    expect(source).toContain('router.post("/shifts/:id/terminate", requireRole("global_admin", "admin", "supervisor")');
    expect(source).toContain('const ShiftReassignmentBody = z.object({ targetShiftId: z.number().int().positive(), reason: z.string().trim().min(3).max(240) }).strict()');
    expect(source).toContain('const ShiftTerminationBody = z.object({ cashBankEnd: z.number().finite().nonnegative(), reason: z.string().trim().min(3).max(240) }).strict()');
  });

  it("enforces tenant and active-state checks before moving orders or terminating", () => {
    expect(source).toContain('eq(labTechShiftsTable.tenantId, tenantId), eq(labTechShiftsTable.status, "active")');
    expect(source).toContain('eq(labTechShiftsTable.id, parsed.data.targetShiftId), eq(labTechShiftsTable.tenantId, tenantId), eq(labTechShiftsTable.status, "active")');
    expect(source).toContain('Reassign active orders before terminating this shift');
    expect(source).toContain('eq(labTechShiftsTable.status, "active"))).returning()');
  });

  it("keeps finalized shifts out of the management path and audits both actions", () => {
    expect(source).toContain('action: "SHIFT_ORDERS_REASSIGNED"');
    expect(source).toContain('action: "SHIFT_ADMIN_TERMINATED"');
    expect(source).toContain('requireRole("global_admin", "admin", "supervisor")');
  });
});
