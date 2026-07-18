import { and, eq, sql } from "drizzle-orm";
import { db, tenantSettingsTable, tenantsTable } from "@workspace/db";
import type { BusinessAddress, BusinessSettingsPatch } from "./configSchemas";

export type SafeTenantBusinessSettings = {
  version: number;
  legalBusinessName: string | null;
  publicBusinessName: string;
  appName: string;
  websiteUrl: string | null;
  storefrontUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  businessAddress: BusinessAddress;
  timezone: string;
  defaultCurrency: string;
  businessDescription: string | null;
  updatedAt: Date | string | null;
};

export type SafeTenantSettings = {
  business: SafeTenantBusinessSettings;
};

const FALLBACK_NAME = "MyOrder.fun";
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_CURRENCY = "USD";

function normalizeAddress(value: unknown): BusinessAddress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  return {
    line1: typeof input.line1 === "string" ? input.line1 : null,
    line2: typeof input.line2 === "string" ? input.line2 : null,
    city: typeof input.city === "string" ? input.city : null,
    region: typeof input.region === "string" ? input.region : null,
    postalCode: typeof input.postalCode === "string" ? input.postalCode : null,
    country: typeof input.country === "string" ? input.country : null,
  };
}

function tenantDisplayName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed || FALLBACK_NAME;
}

export async function backfillTenantSettings(): Promise<void> {
  await db.execute(sql`
    INSERT INTO tenant_settings (tenant_id, public_business_name, app_name, timezone, default_currency, version)
    SELECT id, name, name, 'America/Los_Angeles', 'USD', 1
    FROM tenants t
    WHERE NOT EXISTS (SELECT 1 FROM tenant_settings ts WHERE ts.tenant_id = t.id)
  `);
}

export async function ensureTenantSettingsRow(tenantId: number): Promise<boolean> {
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw new Error("tenantId must be a positive integer");
  await db.execute(sql`
    INSERT INTO tenant_settings (tenant_id, public_business_name, app_name, timezone, default_currency, version)
    SELECT t.id, t.name, t.name, 'America/Los_Angeles', 'USD', 1
    FROM tenants t
    WHERE t.id = ${tenantId}
    ON CONFLICT (tenant_id) DO NOTHING
  `);
  const [tenant] = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  return !!tenant;
}

export async function getTenantSettings(tenantId: number): Promise<SafeTenantSettings | null> {
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw new Error("tenantId must be a positive integer");
  const exists = await ensureTenantSettingsRow(tenantId);
  if (!exists) return null;
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  const [settings] = await db.select().from(tenantSettingsTable).where(eq(tenantSettingsTable.tenantId, tenantId)).limit(1);
  const displayName = tenantDisplayName(tenant.name);
  return {
    business: {
      version: settings?.version ?? 1,
      legalBusinessName: settings?.legalBusinessName ?? null,
      publicBusinessName: settings?.publicBusinessName?.trim() || displayName,
      appName: settings?.appName?.trim() || displayName,
      websiteUrl: settings?.websiteUrl ?? null,
      storefrontUrl: settings?.storefrontUrl ?? null,
      supportEmail: settings?.supportEmail ?? null,
      supportPhone: settings?.supportPhone ?? null,
      businessAddress: normalizeAddress(settings?.businessAddressJson),
      timezone: settings?.timezone ?? DEFAULT_TIMEZONE,
      defaultCurrency: settings?.defaultCurrency ?? DEFAULT_CURRENCY,
      businessDescription: settings?.businessDescription ?? null,
      updatedAt: settings?.updatedAt ?? null,
    },
  };
}

export async function updateTenantBusinessSettings(input: {
  tenantId: number;
  actorUserId: number;
  patch: BusinessSettingsPatch;
}): Promise<{ updated: SafeTenantSettings | null; stale: boolean; missing: boolean }> {
  const current = await getTenantSettings(input.tenantId);
  if (!current) return { updated: null, stale: false, missing: true };

  const setValues: Record<string, unknown> = { updatedAt: new Date(), updatedByUserId: input.actorUserId };
  const p = input.patch;
  if (Object.prototype.hasOwnProperty.call(p, "legalBusinessName")) setValues.legalBusinessName = p.legalBusinessName ?? null;
  if (Object.prototype.hasOwnProperty.call(p, "publicBusinessName")) setValues.publicBusinessName = p.publicBusinessName ?? null;
  if (Object.prototype.hasOwnProperty.call(p, "appName")) setValues.appName = p.appName ?? null;
  if (Object.prototype.hasOwnProperty.call(p, "websiteUrl")) setValues.websiteUrl = p.websiteUrl ?? null;
  if (Object.prototype.hasOwnProperty.call(p, "storefrontUrl")) setValues.storefrontUrl = p.storefrontUrl ?? null;
  if (Object.prototype.hasOwnProperty.call(p, "supportEmail")) setValues.supportEmail = p.supportEmail ?? null;
  if (Object.prototype.hasOwnProperty.call(p, "supportPhone")) setValues.supportPhone = p.supportPhone ?? null;
  if (Object.prototype.hasOwnProperty.call(p, "businessAddress")) setValues.businessAddressJson = p.businessAddress ?? {};
  if (Object.prototype.hasOwnProperty.call(p, "timezone")) setValues.timezone = p.timezone;
  if (Object.prototype.hasOwnProperty.call(p, "defaultCurrency")) setValues.defaultCurrency = p.defaultCurrency;
  if (Object.prototype.hasOwnProperty.call(p, "businessDescription")) setValues.businessDescription = p.businessDescription ?? null;

  const [updatedRow] = await db.transaction(async (tx: typeof db) => tx.update(tenantSettingsTable)
    .set({ ...setValues, version: input.patch.version + 1 })
    .where(and(eq(tenantSettingsTable.tenantId, input.tenantId), eq(tenantSettingsTable.version, input.patch.version)))
    .returning());

  if (!updatedRow) return { updated: null, stale: true, missing: false };
  return { updated: await getTenantSettings(input.tenantId), stale: false, missing: false };
}
