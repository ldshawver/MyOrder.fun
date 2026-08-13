import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../catalog.ts"), "utf8");

describe("catalog creation security", () => {
  it("keeps creation restricted to admin roles", () => {
    expect(source).toContain('router.post("/catalog", requireRole("global_admin", "admin")');
  });

  it("uses the authenticated tenant and fails closed for an unscoped tenant admin", () => {
    expect(source).toContain("const actor = req.dbUser!");
    expect(source).toContain("const tenantId = actor.tenantId ?? (normalizeRole(actor.role) === \"global_admin\"");
    expect(source).toContain('res.status(403).json({ error: "Tenant assignment required" })');
  });
});
