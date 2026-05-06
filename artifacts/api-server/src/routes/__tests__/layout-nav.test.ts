/**
 * Smoke test for the platform sidebar nav. Two duplicates were removed
 * during the user-management simplification:
 *   - "Catalogue Editor" (same /catalog href as "Catalog")
 *   - "AI Onboarding"   (multi-tenant feature, dead in single-tenant deploy)
 *
 * The platform package has no test runner, so this lives in the api-server
 * vitest suite and reads the layout source file directly. That keeps the
 * assertion independent of the full React render tree (which would
 * otherwise need Clerk + brand context mocking just to check labels).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const layoutSrc = readFileSync(
  resolve(__dirname, "../../../../platform/src/components/layout.tsx"),
  "utf8",
);

describe("layout sidebar nav", () => {
  it("does not include the duplicate 'Catalogue Editor' entry", () => {
    expect(layoutSrc).not.toMatch(/label:\s*"Catalogue Editor"/);
  });

  it("does not include the multi-tenant 'AI Onboarding' entry", () => {
    expect(layoutSrc).not.toMatch(/label:\s*"AI Onboarding"/);
  });

  it("uses the simplified 'Users' label for the user-approvals page", () => {
    expect(layoutSrc).toMatch(/href:\s*"\/admin\/users",\s*label:\s*"Users"/);
    expect(layoutSrc).not.toMatch(/label:\s*"User Approvals"/);
  });

  it("only declares /catalog once in the nav list", () => {
    const matches = layoutSrc.match(/href:\s*"\/catalog"/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
