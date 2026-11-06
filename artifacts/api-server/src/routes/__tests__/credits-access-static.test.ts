import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const creditsSource = readFileSync(join(process.cwd(), "src/routes/credits.ts"), "utf8");
const paymentsSource = readFileSync(join(process.cwd(), "src/routes/payments.ts"), "utf8");
const feedbackSource = readFileSync(join(process.cwd(), "src/routes/feedback.ts"), "utf8");
const indexSource = readFileSync(join(process.cwd(), "src/routes/index.ts"), "utf8");

describe("Customer Credit access safeguards", () => {
  it("allows an approved member to self-view Customer Credit without historical approver metadata", () => {
    expect(creditsSource).toContain('router.get("/credits/me", ...ownCreditAuth');
    expect(creditsSource).toContain("requireCustomerSelfServiceAccess");
    expect(creditsSource).toContain("eq(customerCreditAccountsTable.customerId, actor.id)");
    expect(creditsSource).toContain('router.get("/admin/credits", ...adminCreditAuth, requirePermission("billing.manage")');
    expect(creditsSource).toContain('router.post("/admin/credits", ...adminCreditAuth, requirePermission("billing.manage")');
  });

  it("serves own feedback and store credit before the path-less provenance routers", () => {
    const feedbackAt = indexSource.indexOf("router.use(feedbackRouter)");
    const creditsAt = indexSource.indexOf("router.use(creditsRouter)");
    const catalogAt = indexSource.indexOf("router.use(catalogRouter)");
    const settingsAt = indexSource.indexOf("router.use(settingsRouter)");
    expect(feedbackAt).toBeGreaterThan(-1);
    expect(creditsAt).toBeGreaterThan(feedbackAt);
    expect(catalogAt).toBeGreaterThan(creditsAt);
    expect(settingsAt).toBeGreaterThan(catalogAt);
    expect(feedbackSource).toContain("requireCustomerSelfServiceAccess");
    expect(feedbackSource).toContain("next(\"router\")");
    expect(feedbackSource).toContain("requireApproved(req, res, next)");
  });

  it("requires billing permission for admin credit management", () => {
    expect(creditsSource).toContain('requirePermission("billing.manage")');
  });

  it("prevents other-user order credit application", () => {
    expect(paymentsSource).toContain("eq(ordersTable.customerId, actor.id)");
    expect(paymentsSource).toContain("eq(ordersTable.tenantId, actor.tenantId!)");
  });
});
