import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";

export const SUPPORTED_BUSINESS_CURRENCIES = ["USD"] as const;
function hasControlChars(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
const HTML_TAG = /<\s*\/?\s*[a-zA-Z][^>]*>/;
const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal"] as const;

function plainText(max: number, field: string) {
  return z.string()
    .max(max, `${field} must be ${max} characters or fewer`)
    .refine((v) => !hasControlChars(v), `${field} contains unsupported control characters`)
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
    .refine((v) => !hasControlChars(v), "URL contains unsupported control characters")
    .transform((v) => v === "" ? null : v)
    .nullable()
    .refine((value) => {
      if (value === null) return true;
      try {
        const url = new URL(value);
        if (url.username || url.password) return false;
        if (!url.hostname || hasControlChars(url.hostname) || url.hostname.includes("\0")) return false;
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
