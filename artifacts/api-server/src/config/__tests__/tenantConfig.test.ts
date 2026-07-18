import { beforeEach, describe, expect, it, vi } from "vitest";

type TenantRow = { id: number; name: string };
type SettingsRow = {
  tenantId: number;
  version: number;
  publicBusinessName: string | null;
  appName: string | null;
  timezone: string;
  defaultCurrency: string;
  legalBusinessName?: string | null;
  websiteUrl?: string | null;
  storefrontUrl?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  businessAddressJson?: Record<string, unknown>;
  businessDescription?: string | null;
  updatedAt?: Date | null;
  updatedByUserId?: number | null;
};

const state: { tenants: TenantRow[]; settings: SettingsRow[] } = { tenants: [], settings: [] };
const tenantsTable = { id: { table: "tenants", key: "id" }, name: { table: "tenants", key: "name" } };
const tenantSettingsTable = {
  tenantId: { table: "tenant_settings", key: "tenantId" },
  version: { table: "tenant_settings", key: "version" },
};

function conditionValue(condition: unknown, key: string): unknown {
  if (!condition || typeof condition !== "object") return undefined;
  const c = condition as { type?: string; column?: { key?: string }; value?: unknown; conditions?: unknown[] };
  if (c.type === "eq" && c.column?.key === key) return c.value;
  if (c.type === "and") return c.conditions?.map((child) => conditionValue(child, key)).find((value) => value !== undefined);
  return undefined;
}

function selectRows(table: unknown, condition: unknown): unknown[] {
  const id = conditionValue(condition, "id");
  const tenantId = conditionValue(condition, "tenantId");
  if (table === tenantsTable) return state.tenants.filter((tenant) => id === undefined || tenant.id === id);
  if (table === tenantSettingsTable) return state.settings.filter((setting) => tenantId === undefined || setting.tenantId === tenantId);
  return [];
}

vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock("@workspace/db", () => {
  const db = {
    async execute(query: { values?: unknown[] }) {
      const tenantId = query.values?.[0] as number | undefined;
      const tenants = tenantId ? state.tenants.filter((tenant) => tenant.id === tenantId) : state.tenants;
      for (const tenant of tenants) {
        if (!state.settings.some((setting) => setting.tenantId === tenant.id)) {
          state.settings.push({ tenantId: tenant.id, version: 1, publicBusinessName: tenant.name, appName: tenant.name, timezone: "America/Los_Angeles", defaultCurrency: "USD", businessAddressJson: {} });
        }
      }
    },
    select() {
      return {
        from(table: unknown) {
          return {
            where(condition: unknown) {
              return { limit: (count: number) => selectRows(table, condition).slice(0, count) };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Partial<SettingsRow>) {
          return {
            where(condition: unknown) {
              return {
                returning() {
                  if (table !== tenantSettingsTable) return [];
                  const tenantId = conditionValue(condition, "tenantId");
                  const version = conditionValue(condition, "version");
                  const row = state.settings.find((setting) => setting.tenantId === tenantId && setting.version === version);
                  if (!row) return [];
                  Object.assign(row, values);
                  return [row];
                },
              };
            },
          };
        },
      };
    },
    transaction<T>(callback: (tx: typeof db) => T) { return callback(db); },
  };
  return { db, tenantsTable, tenantSettingsTable };
});

const { getTenantSettings, updateTenantBusinessSettings, ensureTenantSettingsRow } = await import("../tenantConfig");

beforeEach(() => {
  state.tenants = [{ id: 1, name: "Tenant A" }, { id: 2, name: "Tenant B" }];
  state.settings = [];
});

describe("tenantConfig initialization and guarded updates", () => {
  it("initializes missing tenant_settings rows and is idempotent", async () => {
    const settings = await getTenantSettings(1);
    expect(settings?.business.publicBusinessName).toBe("Tenant A");
    expect(settings?.business.version).toBe(1);
    expect(state.settings).toHaveLength(1);

    state.settings[0].publicBusinessName = "Existing A";
    await ensureTenantSettingsRow(1);
    expect(state.settings).toHaveLength(1);
    expect(state.settings[0].publicBusinessName).toBe("Existing A");
  });

  it("handles concurrent first initialization without duplicate rows", async () => {
    await Promise.all([ensureTenantSettingsRow(1), ensureTenantSettingsRow(1), ensureTenantSettingsRow(1)]);
    expect(state.settings.filter((setting) => setting.tenantId === 1)).toHaveLength(1);
  });

  it("updates after initialization and preserves tenant isolation", async () => {
    const initial = await getTenantSettings(1);
    await getTenantSettings(2);
    const result = await updateTenantBusinessSettings({ tenantId: 1, actorUserId: 10, patch: { version: initial!.business.version, publicBusinessName: "Updated A" } });
    expect(result.updated?.business.version).toBe(2);
    expect(result.updated?.business.publicBusinessName).toBe("Updated A");
    expect(state.settings.find((setting) => setting.tenantId === 2)?.publicBusinessName).toBe("Tenant B");
  });

  it("returns stale for an outdated version and missing for a nonexistent tenant", async () => {
    await getTenantSettings(1);
    await updateTenantBusinessSettings({ tenantId: 1, actorUserId: 10, patch: { version: 1, publicBusinessName: "First" } });
    const stale = await updateTenantBusinessSettings({ tenantId: 1, actorUserId: 10, patch: { version: 1, publicBusinessName: "Second" } });
    expect(stale.stale).toBe(true);
    expect(state.settings.find((setting) => setting.tenantId === 1)?.publicBusinessName).toBe("First");

    const missing = await updateTenantBusinessSettings({ tenantId: 999, actorUserId: 10, patch: { version: 1, publicBusinessName: "Missing" } });
    expect(missing.missing).toBe(true);
  });
});
