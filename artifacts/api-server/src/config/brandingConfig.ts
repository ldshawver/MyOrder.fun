import { eq } from "drizzle-orm";
import { db, tenantsTable, tenantSettingsTable } from "@workspace/db";
import { PLATFORM_BRAND, resolvePublicBrandingForHost, resolveStagingPublicBrandingAlias, type PublicStorefrontBranding, type TenantBrandingEnvelope } from "./publicStorefrontBranding";
export { PLATFORM_BRAND } from "./publicStorefrontBranding";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}


/** Resolve an exact configured storefront host without exposing tenant IDs. */
export async function getPublicBrandingForHost(host: string): Promise<PublicStorefrontBranding | null> {
  const rows = await db.select({
    tenantId: tenantsTable.id,
    settings: tenantsTable.settings,
    storefrontUrl: tenantSettingsTable.storefrontUrl,
    publicBusinessName: tenantSettingsTable.publicBusinessName,
    businessDescription: tenantSettingsTable.businessDescription,
  }).from(tenantsTable).leftJoin(tenantSettingsTable, eq(tenantSettingsTable.tenantId, tenantsTable.id));

  return resolvePublicBrandingForHost(host, rows)
    ?? resolveStagingPublicBrandingAlias(host, rows, {
      runtimeEnvironment: process.env.NODE_ENV,
      host: process.env.STAGING_PUBLIC_STOREFRONT_HOST,
      tenantId: process.env.STAGING_PUBLIC_TENANT_ID,
    });
}

export async function getBranding(tenantId: number) {
  const [tenant] = await db.select({ name: tenantsTable.name, settings: tenantsTable.settings })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  if (!tenant) return null;
  const settings = object(tenant.settings);
  const branding = object(settings.branding) as TenantBrandingEnvelope;
  const customer = object(branding.customer);
  const supplier = object(branding.supplier);
  return {
    platform: PLATFORM_BRAND,
    customer: {
      // The authenticated platform defaults to MyOrder.fun. Merchant-facing
      // identity is carried explicitly by the supplier/catalogue context.
      displayName: String(customer.displayName ?? "").trim() || PLATFORM_BRAND.displayName,
      legalName: customer.legalName ?? null,
      logoUrl: customer.logoUrl ?? PLATFORM_BRAND.logoUrl,
      faviconUrl: customer.faviconUrl ?? PLATFORM_BRAND.faviconUrl,
      primaryColor: customer.primaryColor ?? PLATFORM_BRAND.primaryColor,
      secondaryColor: customer.secondaryColor ?? PLATFORM_BRAND.secondaryColor,
      supportEmail: customer.supportEmail ?? null,
      supportPhone: customer.supportPhone ?? null,
      websiteUrl: customer.websiteUrl ?? null,
      checkoutDescriptor: customer.checkoutDescriptor ?? null,
      termsDisclaimer: customer.termsDisclaimer ?? null,
      privacyNotice: customer.privacyNotice ?? null,
      customDomain: customer.customDomain ?? null,
      domainVerificationState: customer.domainVerificationState ?? "unconfigured",
    },
    supplier: {
      displayName: supplier.displayName ?? (String(tenant.name ?? "").trim() || null),
      logoUrl: supplier.logoUrl ?? null,
      attribution: supplier.attribution ?? null,
      disclaimer: supplier.disclaimer ?? null,
      showAttribution: supplier.showAttribution === true,
    },
  };
}

export async function updateBranding(tenantId: number, patch: TenantBrandingEnvelope) {
  const [tenant] = await db.select({ settings: tenantsTable.settings }).from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId)).limit(1);
  if (!tenant) return null;
  const settings = object(tenant.settings);
  const current = object(settings.branding);
  const nextBranding = {
    ...current,
    ...(patch.customer ? { customer: { ...object(current.customer), ...patch.customer } } : {}),
    ...(patch.supplier ? { supplier: { ...object(current.supplier), ...patch.supplier } } : {}),
  };
  await db.update(tenantsTable).set({ settings: { ...settings, branding: nextBranding }, updatedAt: new Date() })
    .where(eq(tenantsTable.id, tenantId));
  return getBranding(tenantId);
}
