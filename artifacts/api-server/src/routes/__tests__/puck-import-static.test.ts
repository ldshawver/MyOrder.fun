import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(new URL("../visual-editor.ts", import.meta.url), "utf8");

describe("Puck import API abuse regressions", () => {
  it("requires auth, admin role, and pages.manage permission for import endpoints", () => {
    expect(route).toContain('router.use("/admin/pages", requireAuth, loadDbUser, requireDbUser, requireApproved');
    expect(route).toContain('requireRole("global_admin", "admin", "tenant_admin")');
    expect(route).toContain('"pages.manage"');
  });

  it("uses strict schemas so hidden ownership/publish fields are rejected", () => {
    expect(route).toContain("importSourceSchema");
    expect(route).toContain("importPageSchema");
    expect(route.match(/\.strict\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("tenant-scopes pageId and path lookups to the current actor tenant", () => {
    expect(route).toContain("actorTenantId(req)");
    expect(route).toContain("eq(visualEditorPagesTable.tenantId, tenantId)");
  });

  it("saves imports as draft, creates history, audits success and failure, and does not publish", () => {
    expect(route).toContain('status: "draft"');
    expect(route).toContain("visualEditorPageVersionsTable");
    expect(route).toContain("visual_editor.import_started");
    expect(route).toContain("visual_editor.import_saved_as_draft");
    expect(route).toContain("visual_editor.import_failed");
    expect(route).toContain("visual_editor.imported_page_published");
    expect(route).not.toContain("publishedJson: draftJson");
  });
});
