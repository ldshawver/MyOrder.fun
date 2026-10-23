import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../catalog.ts"), "utf8");

describe("catalog creation security", () => {
  it("keeps creation restricted to admin roles", () => {
    expect(source).toContain('router.post("/catalog", requireRole("global_admin", "admin")');
  });

  it("uses the authenticated tenant and fails closed for an unscoped tenant admin", () => {
    expect(source).toContain("router.use(requireAuth, loadDbUser, requireDbUser, requireCatalogReadAccess, requireTenantContext)");
    expect(source).toContain("const tenantId = req.authorizedTenantId!");
  });

  it("keeps privileged catalogue views and mutations behind full approval provenance", () => {
    expect(source).toContain("evaluateAccountApproval(req, actor).allowed");
    expect(source).toContain('router.post("/catalog", requireRole("global_admin", "admin")');
  });

  it("normalizes nullable database text before parsing catalog responses", () => {
    expect(source).toContain("description: i.description ?? undefined");
    expect(source).toContain("sku: i.sku ?? undefined");
  });
});
