import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../shifts.ts"), "utf8");

describe("supervisor commission closeout contract", () => {
  it("allows only a supervisor-class role and the four approved whole rates", () => {
    const start = source.indexOf('"/shifts/:id/supervisor-checkout"');
    const section = source.slice(start, start + 3000);
    expect(section).toContain('requireRole("global_admin", "admin", "supervisor")');
    expect(section).toContain('z.union([z.literal(15), z.literal(16), z.literal(17), z.literal(18)])');
  });

  it("tenant-scopes the selected shift, snapshots the rate, and audits finalization", () => {
    const start = source.indexOf('"/shifts/:id/supervisor-checkout"');
    const section = source.slice(start, start + 30000);
    expect(section).toContain("eq(labTechShiftsTable.tenantId, tenantId)");
    expect(section).toContain("commissionRate: (tipPercent / 100).toFixed(6)");
    expect(section).toContain('action: "SHIFT_CLOSEOUT_PACKAGE_FINALIZED"');
  });

  it("uses the immutable closeout snapshot for the final deposit print", () => {
    expect(source).toContain('kind: "supervisor_checkout"');
    expect(source).toContain("eligibleSales: checkout.commissionBasis");
    expect(source).toContain("...checkout.cashReconciliation");
  });
});
