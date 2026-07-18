import { createHash } from "node:crypto";

const AUDITED_BUSINESS_FIELDS = [
  "legalBusinessName",
  "publicBusinessName",
  "appName",
  "websiteUrl",
  "storefrontUrl",
  "supportEmail",
  "supportPhone",
  "businessAddress",
  "timezone",
  "defaultCurrency",
  "businessDescription",
] as const;

export function changedBusinessFieldNames(patch: Record<string, unknown>): string[] {
  return AUDITED_BUSINESS_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
}

export function hashForAudit(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

export function compactUserAgent(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 160);
}
