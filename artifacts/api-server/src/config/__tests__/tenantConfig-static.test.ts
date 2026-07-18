import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("tenant settings migration and service contract", () => {
  it("creates normalized tenant_settings with guarded version and idempotent backfill", () => {
    const migration = readFileSync(new URL("../../../../../lib/db/drizzle/0032_tenant_settings.sql", import.meta.url), "utf8");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "tenant_settings"');
    expect(migration).toContain('"tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE');
    expect(migration).toContain('"updated_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL');
    expect(migration).toContain('CHECK ("version" > 0)');
    expect(migration).toContain('CHECK ("default_currency" ~ \'^[A-Z]{3}$\')');
    expect(migration).toContain('WHERE NOT EXISTS (');
    expect(migration).toContain('t."name"');
    expect(migration).not.toContain('admin_settings');
    expect(migration).not.toContain('tenants" SET');
  });

  it("tenantConfig initializes missing rows idempotently without single-tenant fallback", () => {
    const source = readFileSync(new URL("../tenantConfig.ts", import.meta.url), "utf8");
    expect(source).not.toContain("getHouseTenantId");
    expect(source).not.toContain("process.env");
    expect(source).toContain("ensureTenantSettingsRow");
    expect(source).toContain("ON CONFLICT (tenant_id) DO NOTHING");
    expect(source).toContain("WHERE t.id = ${tenantId}");
    expect(source).toContain("SELECT t.id, t.name, t.name");
    expect(source).toContain("eq(tenantSettingsTable.tenantId, input.tenantId)");
    expect(source).toContain("eq(tenantSettingsTable.version, input.patch.version)");
    expect(source).not.toContain("tenantSettingsTable.id");
  });
});
