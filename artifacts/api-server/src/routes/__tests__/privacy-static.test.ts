import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, "../..");
const platformRoot = resolve(__dirname, "../../../../platform/src");

function apiSrc(relativePath: string): string {
  return readFileSync(resolve(apiRoot, relativePath), "utf8");
}

function platformSrc(relativePath: string): string {
  return readFileSync(resolve(platformRoot, relativePath), "utf8");
}

describe("privacy protection implementation", () => {
  const privacyRoute = apiSrc("routes/privacy.ts");
  const sensitiveScreen = platformSrc("components/privacy/SensitiveScreen.tsx");
  const css = platformSrc("index.css");
  const app = platformSrc("App.tsx");

  it("derives privacy event user, role, and tenant from req.dbUser only", () => {
    expect(privacyRoute).toContain("router.use(requireAuth, loadDbUser, requireDbUser, requireApproved)");
    expect(privacyRoute).toContain("const user = req.dbUser!");
    expect(privacyRoute).toContain("actorId: user.id");
    expect(privacyRoute).toContain("actorRole: user.role");
    expect(privacyRoute).toContain("tenantId: user.tenantId");
    expect(privacyRoute).not.toMatch(/req\.body\.(user|userId|tenant|tenantId|role)/);
  });

  it("strictly validates event/settings payloads and rate limits event spam", () => {
    expect(privacyRoute).toMatch(/eventSchema = z\.object\([\s\S]*\.strict\(\)/);
    expect(privacyRoute).toMatch(/settingsSchema = z\.object\([\s\S]*\.strict\(\)/);
    expect(privacyRoute).toContain("limit: 20");
  });

  it("tenant-scopes privacy settings and restricts updates to admins", () => {
    expect(privacyRoute).toContain('router.put("/admin/privacy-settings", requireRole("admin", "global_admin")');
    expect(privacyRoute).toContain("const tenantId = req.dbUser!.tenantId");
    expect(privacyRoute).toContain("where(eq(adminSettingsTable.tenantId, tenantId))");
    expect(privacyRoute).not.toMatch(/req\.body\.(tenant|tenantId|company|companyId)/);
  });

  it("protects sensitive routes without relying on route inventory comments", () => {
    expect(app).toContain('<Route path="/orders/:id">{() => protect(<OrderDetail />)}</Route>');
    expect(app).toContain('<Route path="/staff">{() => protect(<StaffQueue />)}</Route>');
    expect(app).toContain('<Route path="/account">{() => protect(<Account />)}</Route>');
    expect(app).not.toContain("Static route inventory");
  });

  it("keeps forms usable while applying contextual deterrence", () => {
    expect(sensitiveScreen).toContain("isEditableTarget");
    expect(sensitiveScreen).toContain("input, textarea, select");
    expect(sensitiveScreen).toContain("if (!active || isEditableTarget(event.target)) return");
    expect(css).toMatch(/\.sensitive-screen input,[\s\S]*user-select: text/);
  });

  it("prints only hide sensitive content and keep the warning visible", () => {
    expect(css).toContain(".sensitive-screen-content");
    expect(css).not.toMatch(/@media print \{[\s\S]*\.sensitive-screen \{[\s\S]*display: none/);
    expect(css).toMatch(/\.sensitive-print-warning \{[\s\S]*display: block !important/);
  });

  it("masks email in watermarks instead of rendering raw full addresses", () => {
    expect(sensitiveScreen).toContain("function maskEmail");
    expect(sensitiveScreen).toContain("maskEmail(userEmail)");
    expect(sensitiveScreen).not.toMatch(/\[userEmail \|\| "unknown user"/);
  });
});
