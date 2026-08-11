import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const sql = readFileSync(resolve(root, "lib/db/drizzle/0040_tenant_printing_reporting_foundation.sql"), "utf8");

describe("migration 0040 printing/reporting security foundation", () => {
  it("makes printing ownership mandatory and enforces composite tenant references", () => {
    for (const table of ["print_bridge_profiles", "print_printers", "operator_print_profiles", "print_assets", "print_templates", "print_jobs", "print_job_attempts"]) {
      expect(sql).toContain(`ALTER TABLE "${table}" ALTER COLUMN "tenant_id" SET NOT NULL`);
    }
    expect(sql).toContain("print_printers_bridge_tenant_fk");
    expect(sql).toContain("print_jobs_printer_tenant_fk");
    expect(sql).toContain("operator_print_profiles_no_fallback_check");
  });

  it("requires location scope to carry a location and prevents globally ambiguous Box registration", () => {
    expect(sql).toContain("print_printers_scope_check");
    expect(sql).toContain("routing_scope = 'location' AND location_id IS NOT NULL");
    expect(sql).toContain("shift_print_assignments");
  });

  it("creates immutable one-per-order and one-per-shift snapshots", () => {
    expect(sql).toContain("UNIQUE (tenant_id, order_id)");
    expect(sql).toContain("UNIQUE (tenant_id, shift_id)");
    expect(sql).toContain("commission_snapshots");
    expect(sql).toContain("print_template_versions");
  });
});
