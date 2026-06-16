import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../..");
function src(relativePath: string): string { return readFileSync(resolve(repoRoot, relativePath), "utf8"); }

const routeSrc = src("artifacts/api-server/src/routes/visual-editor.ts");
const appSrc = src("artifacts/platform/src/App.tsx");
const configSrc = src("artifacts/platform/src/visual-editor/puckConfig.tsx");
const migrationSrc = src("lib/db/drizzle/0024_visual_editor_versions.sql");

describe("visual editor hardening", () => {
  it("keeps admin API access limited to global/admin roles and excludes supervisor from visual editor UI routes", () => {
    expect(routeSrc).toContain('requireRole("global_admin", "admin")');
    expect(appSrc).toContain('"tenant_admin"');
    expect(appSrc).toMatch(/\["global_admin", "admin", "tenant_admin"\]\.includes\(normalizeRouteRole\(user\.role\)\)[\s\S]*\/admin\/visual-editor/);
    expect(appSrc).toContain('if (normalized === "global_admin" || normalized === "admin" || normalized === "tenant_admin" || normalized === "supervisor") return normalized;');
  });

  it("allowlists safe Puck components and rejects restricted catalog/business fields", () => {
    expect(routeSrc).toContain("COMPONENT_PROP_ALLOWLIST");
    expect(routeSrc).toContain("CatalogPresentationBlock");
    for (const restricted of ["inventoryCount", "inventoryLocationId", "checkoutQuantity", "serverPrice", "paymentState", "tenantId", "permission"]) {
      expect(routeSrc).toContain(restricted);
    }
    expect(routeSrc).toContain("Unapproved prop");
    expect(routeSrc).toContain("HTML/script content rejected");
    expect(routeSrc).toContain("Unsafe URL rejected");
  });

  it("keeps catalog editing presentation-only in the Puck registry", () => {
    expect(configSrc).toContain("CatalogPresentationBlock");
    for (const allowed of ["displayName", "description", "categoryDisplay", "badges", "featured", "sortOrder", "quantityLabel", "priceDisplayFormat", "availabilityText", "layoutStyle", "visible"]) {
      expect(configSrc).toContain(allowed);
    }
    expect(configSrc).toContain("Inventory and pricing logic stay in secured product/inventory APIs");
  });

  it("uses compatibility-safe migration guards and backfill before not-null enforcement", () => {
    expect(migrationSrc).toContain("information_schema.columns");
    expect(migrationSrc).toContain("ADD COLUMN IF NOT EXISTS");
    expect(migrationSrc).toContain('UPDATE "visual_editor_pages"');
    expect(migrationSrc).toContain('ALTER COLUMN "created_by_user_id" SET NOT NULL');
  });
});
