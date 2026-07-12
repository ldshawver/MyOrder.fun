import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const creditsSource = readFileSync(join(process.cwd(), "src/routes/credits.ts"), "utf8");
const paymentsSource = readFileSync(join(process.cwd(), "src/routes/payments.ts"), "utf8");

describe("store credit access safeguards", () => {
  it("allows approved authenticated users to self-view store credit without role gating", () => {
    expect(creditsSource).toContain('router.get("/credits/me", ...authChain');
    expect(creditsSource).toContain("eq(userCreditsTable.userId, user.id)");
  });

  it("requires billing permission for admin credit management", () => {
    expect(creditsSource).toContain('requirePermission("billing.manage")');
  });

  it("prevents other-user order credit application", () => {
    expect(paymentsSource).toContain("if (order.customerId !== actor.id)");
    expect(paymentsSource).toContain("eq(ordersTable.customerId, actor.id)");
  });
});
