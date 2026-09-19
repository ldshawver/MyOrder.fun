import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";

export const SUPPORTED_BUSINESS_CURRENCIES = ["USD"] as const;
/**
 * Normalize ordinary pasted business text without widening the input surface.
 * Newlines remain newlines, tabs become ordinary spaces, and NBSP is made
 * searchable/renderable as an ordinary space. Other C0 controls stay invalid.
 */
function normalizeHumanText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?|\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\u00a0/g, " ");
}

function hasUnsupportedControlChars(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true;
  }
  return false;
}
const HTML_TAG = /<\s*\/?\s*[a-zA-Z][^>]*>/;
const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal"] as const;

function plainText(max: number, field: string) {
  return z.string()
    .max(max, `${field} must be ${max} characters or fewer`)
    .transform(normalizeHumanText)
    .refine((v) => !hasUnsupportedControlChars(v), `${field} contains unsupported control characters`)
    .refine((v) => !HTML_TAG.test(v), `${field} must be plain text`)
    .transform((v) => v.trim())
    .nullable();
}

const optionalPlainText = (max: number, field: string) => plainText(max, field).optional();

export const businessAddressSchema = z.object({
  line1: optionalPlainText(160, "line1"),
  line2: optionalPlainText(160, "line2"),
  city: optionalPlainText(100, "city"),
  region: optionalPlainText(100, "region"),
  postalCode: optionalPlainText(32, "postalCode"),
  country: z.string().trim().regex(/^[A-Z]{2}$/, "country must be a two-letter uppercase country code").nullable().optional(),
}).strict();

export type BusinessAddress = z.infer<typeof businessAddressSchema>;

function isDevelopmentRuntime(runtimeEnvironment: string | undefined): boolean {
  return runtimeEnvironment === "development" || runtimeEnvironment === "test";
}

function isLoopbackIp(hostname: string): boolean {
  const normalized = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (normalized === "::1") return true;
  const ipv4 = normalized.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return !!ipv4 && Number(ipv4[1]) === 127 && ipv4.slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function isValidPublicDnsHostname(hostname: string): boolean {
  const ascii = domainToASCII(hostname.toLowerCase());
  if (!ascii || ascii.length > 253) return false;
  if (ascii.endsWith(".")) return false;
  if (ascii === "localhost" || INTERNAL_HOST_SUFFIXES.some((suffix) => ascii.endsWith(suffix))) return false;
  if (isIP(ascii)) return false;
  const labels = ascii.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63)) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function isAllowedDevelopmentHost(hostname: string): boolean {
  const ascii = domainToASCII(hostname.toLowerCase());
  return ascii === "localhost" || isLoopbackIp(ascii);
}

/**
 * Business URLs are display/contact metadata, not integration endpoints. In
 * production they must use HTTPS and fully-qualified public DNS hostnames after
 * IDN normalization. Internal names, localhost, IP literals, malformed labels,
 * empty labels, underscores, and unsupported protocols are rejected. Development
 * and test runtimes may additionally use HTTP localhost/loopback URLs for local
 * workflows; that decision is derived only from trusted server runtime config.
 */
function nullableUrl(runtimeEnvironment: string | undefined) {
  const allowDevelopmentLocalUrls = isDevelopmentRuntime(runtimeEnvironment);
  return z.string()
    .trim()
    .max(2048, "URL must be 2048 characters or fewer")
    .refine((v) => !hasUnsupportedControlChars(v), "URL contains unsupported control characters")
    .transform((v) => v === "" ? null : v)
    .nullable()
    .refine((value) => {
      if (value === null) return true;
      try {
        const url = new URL(value);
        if (url.username || url.password) return false;
        if (!url.hostname || hasUnsupportedControlChars(url.hostname) || url.hostname.includes("\0")) return false;
        if (url.protocol === "https:") return isValidPublicDnsHostname(url.hostname) || (allowDevelopmentLocalUrls && isAllowedDevelopmentHost(url.hostname));
        if (url.protocol === "http:" && allowDevelopmentLocalUrls) return isAllowedDevelopmentHost(url.hostname);
        return false;
      } catch {
        return false;
      }
    }, allowDevelopmentLocalUrls ? "URL must be a valid public https URL or a development localhost/loopback URL without embedded credentials" : "URL must be a valid public https URL without embedded credentials")
    .optional();
}

function nullableEmail() {
  return z.string()
    .trim()
    .max(254, "supportEmail must be 254 characters or fewer")
    .transform((v) => v === "" ? null : v)
    .nullable()
    .refine((value) => value === null || z.string().email().safeParse(value).success, "supportEmail must be a valid email address")
    .optional();
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function createBusinessSettingsPatchSchema(options: { runtimeEnvironment?: string } = {}) {
  return z.object({
    version: z.number().int().positive(),
    legalBusinessName: optionalPlainText(160, "legalBusinessName"),
    publicBusinessName: optionalPlainText(120, "publicBusinessName"),
    appName: optionalPlainText(80, "appName"),
    websiteUrl: nullableUrl(options.runtimeEnvironment),
    storefrontUrl: nullableUrl(options.runtimeEnvironment),
    supportEmail: nullableEmail(),
    supportPhone: optionalPlainText(40, "supportPhone"),
    businessAddress: businessAddressSchema.optional(),
    timezone: z.string().trim().max(80).refine(validTimezone, "timezone must be a valid IANA timezone").optional(),
    defaultCurrency: z.enum(SUPPORTED_BUSINESS_CURRENCIES).optional(),
    businessDescription: optionalPlainText(2000, "businessDescription"),
  }).strict();
}

export type BusinessSettingsPatch = z.infer<ReturnType<typeof createBusinessSettingsPatchSchema>>;

const color = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "color must be a six-digit hex value");
const assetPath = z.string().trim().max(2048).refine((value) => value.startsWith("/") || value.startsWith("https://"), "asset must be an absolute application path or HTTPS URL");

export function createBrandingPatchSchema(options: { runtimeEnvironment?: string } = {}) {
  return z.object({
    customer: z.object({
      displayName: optionalPlainText(120, "displayName"),
      legalName: optionalPlainText(160, "legalName"),
      logoUrl: assetPath.nullable().optional(),
      faviconUrl: assetPath.nullable().optional(),
      primaryColor: color.nullable().optional(),
      secondaryColor: color.nullable().optional(),
      supportEmail: nullableEmail(),
      supportPhone: optionalPlainText(40, "supportPhone"),
      websiteUrl: nullableUrl(options.runtimeEnvironment),
      checkoutDescriptor: optionalPlainText(22, "checkoutDescriptor"),
      termsDisclaimer: optionalPlainText(4000, "termsDisclaimer"),
      privacyNotice: optionalPlainText(4000, "privacyNotice"),
      customDomain: z.string().trim().max(253).refine(isValidPublicDnsHostname, "customDomain must be a public DNS hostname").nullable().optional(),
    }).strict().optional(),
    supplier: z.object({
      displayName: optionalPlainText(120, "supplier.displayName"),
      logoUrl: assetPath.nullable().optional(),
      attribution: optionalPlainText(1000, "supplier.attribution"),
      disclaimer: optionalPlainText(4000, "supplier.disclaimer"),
      showAttribution: z.boolean().optional(),
    }).strict().optional(),
  }).strict().refine((value) => value.customer || value.supplier, "branding patch must contain customer or supplier settings");
}

export type BrandingPatch = z.infer<ReturnType<typeof createBrandingPatchSchema>>;
