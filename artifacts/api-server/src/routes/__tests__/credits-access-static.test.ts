import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const creditsSource = readFileSync(join(process.cwd(), "src/routes/credits.ts"), "utf8");
const paymentsSource = readFileSync(join(process.cwd(), "src/routes/payments.ts"), "utf8");

describe("Customer Credit access safeguards", () => {
  it("allows approved authenticated users to self-view Customer Credit without role gating", () => {
    expect(creditsSource).toContain('router.get("/credits/me", ...auth');
    expect(creditsSource).toContain("eq(customerCreditAccountsTable.customerId, actor.id)");
  });

  it("requires billing permission for admin credit management", () => {
    expect(creditsSource).toContain('requirePermission("billing.manage")');
  });

  it("prevents other-user order credit application", () => {
    expect(paymentsSource).toContain("eq(ordersTable.customerId, actor.id)");
    expect(paymentsSource).toContain("eq(ordersTable.tenantId, actor.tenantId!)");
  });
});
