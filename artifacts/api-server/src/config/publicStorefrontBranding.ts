export const PLATFORM_BRAND = {
  displayName: "MyOrder.fun",
  legalName: "MyOrder.fun",
  logoUrl: "/myorder-logo-header.webp",
  mobileLogoUrl: "/myorder-logo-mobile.png",
  faviconUrl: "/favicon-32.png",
  primaryColor: "#0878f9",
  secondaryColor: "#062d73",
} as const;

export type TenantBrandingEnvelope = { customer?: Record<string, unknown>; supplier?: Record<string, unknown> };
export type StorefrontBrandingRecord = { settings: unknown; storefrontUrl: string | null; publicBusinessName: string | null; businessDescription: string | null };
export type PublicStorefrontBranding = { customer: {
  displayName: string; logoUrl: string; faviconUrl: string; primaryColor: string; secondaryColor: string;
  supportEmail: string | null; supportPhone: string | null; websiteUrl: string | null; businessDescription: string | null;
} };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }

/** A strict Host parser; X-Forwarded-Host is deliberately never an input. */
export function normalizeStorefrontHost(value: string | undefined): string | null {
  if (!value || value.length > 253 || value.includes(",") || /[\s/@\\]/.test(value)) return null;
  let parsed: URL;
  try { parsed = new URL(`http://${value}`); } catch { return null; }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") return null;
  const host = parsed.hostname.toLowerCase();
  return host.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host) ? host : null;
}
function storefrontHostFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? normalizeStorefrontHost(url.host) : null;
  } catch { return null; }
}

export function publicBrandingFromRecord(record: StorefrontBrandingRecord): PublicStorefrontBranding | null {
  if (!storefrontHostFromUrl(record.storefrontUrl)) return null;
  const customer = object((object(record.settings).branding as TenantBrandingEnvelope | undefined)?.customer);
  return { customer: {
    displayName: text(record.publicBusinessName) ?? text(customer.displayName) ?? PLATFORM_BRAND.displayName,
    logoUrl: text(customer.logoUrl) ?? PLATFORM_BRAND.logoUrl,
    faviconUrl: text(customer.faviconUrl) ?? PLATFORM_BRAND.faviconUrl,
    primaryColor: text(customer.primaryColor) ?? PLATFORM_BRAND.primaryColor,
    secondaryColor: text(customer.secondaryColor) ?? PLATFORM_BRAND.secondaryColor,
    supportEmail: text(customer.supportEmail), supportPhone: text(customer.supportPhone),
    websiteUrl: text(customer.websiteUrl) ?? text(record.storefrontUrl), businessDescription: text(record.businessDescription),
  } };
}

export function resolvePublicBrandingForHost(host: string, records: StorefrontBrandingRecord[]): PublicStorefrontBranding | null {
  const matches = records.filter((record) => storefrontHostFromUrl(record.storefrontUrl) === host);
  return matches.length === 1 ? publicBrandingFromRecord(matches[0]) : null;
}
