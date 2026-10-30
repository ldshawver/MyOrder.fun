import { and, eq } from "drizzle-orm";
import { db, inventoryLocationsTable, tenantSettingsTable, uberDirectSettingsTable } from "@workspace/db";
import { safeDecrypt } from "./crypto";
import { normalizeUberAddress, type UberAddress, type UberDirectRuntimeConfig, UberDirectConfigError, verifyUberWebhookSignatureForSecret } from "./uberDirect";

type BusinessAddress = { line1?: unknown; line2?: unknown; city?: unknown; region?: unknown; postalCode?: unknown; country?: unknown };

export type UberDirectAdminSettings = {
  enabled: boolean;
  environment: "sandbox" | "production";
  customerId: string | null;
  clientId: string | null;
  clientSecret: { configured: boolean };
  webhookSigningKey: { configured: boolean };
  pickupLocationId: number | null;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  externalStoreId: string | null;
  pickupWindowMinutes: number | null;
  dropoffWindowMinutes: number | null;
  quoteConfigurationComplete: boolean;
  dispatchEnabled: boolean;
  pickupLocations: Array<{ id: number; name: string; type: string; eligible: boolean }>;
};

export type UberDirectQuoteSettings = {
  pickupLocationId: number;
  pickupAddress: UberAddress;
  pickupLatitude: number;
  pickupLongitude: number;
  externalStoreId: string;
  pickupWindowMinutes: number;
  dropoffWindowMinutes: number;
  pickupContact: { name: string; phone: string };
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validateUberQuoteSettings(value: {
  pickupLocationId?: number | null;
  pickupLatitude?: unknown;
  pickupLongitude?: unknown;
  externalStoreId?: string | null;
  pickupWindowMinutes?: number | null;
  dropoffWindowMinutes?: number | null;
}): Omit<UberDirectQuoteSettings, "pickupAddress" | "pickupContact"> | null {
  const latitude = finiteNumber(value.pickupLatitude);
  const longitude = finiteNumber(value.pickupLongitude);
  const externalStoreId = stringValue(value.externalStoreId);
  if (!Number.isSafeInteger(value.pickupLocationId) || Number(value.pickupLocationId) <= 0
    || latitude == null || latitude < -90 || latitude > 90
    || longitude == null || longitude < -180 || longitude > 180
    // eslint-disable-next-line no-control-regex -- reject ASCII control bytes in the saved provider identifier
    || !externalStoreId || externalStoreId.length > 200 || /[\u0000-\u001f\u007f]/.test(externalStoreId)
    || !Number.isSafeInteger(value.pickupWindowMinutes) || Number(value.pickupWindowMinutes) < 5 || Number(value.pickupWindowMinutes) > 240
    || !Number.isSafeInteger(value.dropoffWindowMinutes) || Number(value.dropoffWindowMinutes) < 15 || Number(value.dropoffWindowMinutes) > 480) return null;
  return {
    pickupLocationId: Number(value.pickupLocationId), pickupLatitude: latitude, pickupLongitude: longitude,
    externalStoreId, pickupWindowMinutes: Number(value.pickupWindowMinutes), dropoffWindowMinutes: Number(value.dropoffWindowMinutes),
  };
}

function businessAddressToUberAddress(value: unknown): UberAddress | null {
  const address = (value && typeof value === "object" ? value : {}) as BusinessAddress;
  const line1 = stringValue(address.line1);
  const city = stringValue(address.city);
  const state = stringValue(address.region);
  const zip = stringValue(address.postalCode);
  const country = stringValue(address.country);
  if (!line1 || !city || !state || !zip || !country) return null;
  try {
    return normalizeUberAddress({ street_address: [line1, stringValue(address.line2)].filter((line): line is string => Boolean(line)), city, state, zip_code: zip, country });
  } catch { return null; }
}

async function tenantLocations(tenantId: number) {
  return db.select().from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.isActive, true)));
}

/** Only a canonical Storefront location may use the tenant's canonical business address. */
async function resolvePickupAddress(tenantId: number, pickupLocationId: number): Promise<UberAddress | null> {
  const [location] = await db.select().from(inventoryLocationsTable).where(and(
    eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.id, pickupLocationId), eq(inventoryLocationsTable.isActive, true),
  )).limit(1);
  if (!location || location.type !== "storefront") return null;
  const [tenant] = await db.select({ businessAddressJson: tenantSettingsTable.businessAddressJson }).from(tenantSettingsTable)
    .where(eq(tenantSettingsTable.tenantId, tenantId)).limit(1);
  return businessAddressToUberAddress(tenant?.businessAddressJson);
}

export async function getUberDirectAdminSettings(tenantId: number): Promise<UberDirectAdminSettings> {
  const [stored, locations] = await Promise.all([
    db.select().from(uberDirectSettingsTable).where(eq(uberDirectSettingsTable.tenantId, tenantId)).limit(1).then(rows => rows[0] ?? null),
    tenantLocations(tenantId),
  ]);
  return {
    enabled: stored?.enabled ?? false,
    environment: stored?.environment === "production" ? "production" : "sandbox",
    customerId: stored?.customerId ?? null,
    clientId: stored?.clientId ?? null,
    clientSecret: { configured: Boolean(stored?.clientSecretCiphertext) },
    webhookSigningKey: { configured: Boolean(stored?.webhookSigningKeyCiphertext) },
    pickupLocationId: stored?.pickupLocationId ?? null,
    pickupLatitude: finiteNumber(stored?.pickupLatitude),
    pickupLongitude: finiteNumber(stored?.pickupLongitude),
    externalStoreId: stored?.externalStoreId ?? null,
    pickupWindowMinutes: stored?.pickupWindowMinutes ?? null,
    dropoffWindowMinutes: stored?.dropoffWindowMinutes ?? null,
    quoteConfigurationComplete: Boolean(stored && validateUberQuoteSettings(stored)),
    dispatchEnabled: stored?.dispatchEnabled ?? false,
    pickupLocations: locations.map(location => ({ id: location.id, name: location.name, type: location.type, eligible: location.type === "storefront" })),
  };
}

/** Resolve every non-secret value used in a quote from this tenant's saved data. */
export async function getUberDirectQuoteSettings(tenantId: number): Promise<UberDirectQuoteSettings | null> {
  const [stored] = await db.select().from(uberDirectSettingsTable).where(eq(uberDirectSettingsTable.tenantId, tenantId)).limit(1);
  const validated = stored ? validateUberQuoteSettings(stored) : null;
  if (!stored?.enabled || !validated) return null;
  const [pickupAddress, pickupContact] = await Promise.all([
    resolvePickupAddress(tenantId, validated.pickupLocationId),
    getUberDirectPickupContact(tenantId),
  ]);
  if (!pickupAddress || !pickupContact) return null;
  return { ...validated, pickupAddress, pickupContact };
}

/** Database configuration is the only runtime authority. No env fallback exists. */
export async function getUberDirectRuntimeConfig(tenantId: number): Promise<UberDirectRuntimeConfig | null> {
  const [stored] = await db.select().from(uberDirectSettingsTable).where(eq(uberDirectSettingsTable.tenantId, tenantId)).limit(1);
  if (!stored?.enabled || !stored.customerId || !stored.clientId || !stored.clientSecretCiphertext) return null;
  const clientSecret = safeDecrypt(stored.clientSecretCiphertext);
  if (!clientSecret) return null;
  return { tenantId, environment: stored.environment === "production" ? "production" : "sandbox", customerId: stored.customerId, clientId: stored.clientId, clientSecret };
}

export async function getUberDirectPickupAddress(tenantId: number): Promise<UberAddress | null> {
  const [stored] = await db.select({ pickupLocationId: uberDirectSettingsTable.pickupLocationId }).from(uberDirectSettingsTable).where(eq(uberDirectSettingsTable.tenantId, tenantId)).limit(1);
  return stored?.pickupLocationId ? resolvePickupAddress(tenantId, stored.pickupLocationId) : null;
}

export async function isUberDirectDispatchEnabledForTenant(tenantId: number): Promise<boolean> {
  const [stored] = await db.select({ enabled: uberDirectSettingsTable.enabled, dispatchEnabled: uberDirectSettingsTable.dispatchEnabled }).from(uberDirectSettingsTable).where(eq(uberDirectSettingsTable.tenantId, tenantId)).limit(1);
  return stored?.enabled === true && stored.dispatchEnabled === true;
}

export async function getUberDirectPickupContact(tenantId: number): Promise<{ name: string; phone: string } | null> {
  const [settings] = await db.select({ publicBusinessName: tenantSettingsTable.publicBusinessName, supportPhone: tenantSettingsTable.supportPhone }).from(tenantSettingsTable).where(eq(tenantSettingsTable.tenantId, tenantId)).limit(1);
  const name = stringValue(settings?.publicBusinessName);
  const phone = stringValue(settings?.supportPhone);
  return name && phone ? { name, phone } : null;
}

/** Webhooks are authenticated against the fulfillment's tenant only. */
export async function verifyUberWebhookSignatureForTenant(tenantId: number, rawBody: Buffer, suppliedSignature: string | undefined): Promise<boolean> {
  if (!Number.isInteger(tenantId) || tenantId <= 0 || !suppliedSignature || !/^[a-f0-9]{64}$/i.test(suppliedSignature)) return false;
  const [settings] = await db.select({ secret: uberDirectSettingsTable.webhookSigningKeyCiphertext }).from(uberDirectSettingsTable)
    .where(and(eq(uberDirectSettingsTable.tenantId, tenantId), eq(uberDirectSettingsTable.enabled, true))).limit(1);
  const signingKey = settings?.secret ? safeDecrypt(settings.secret) : null;
  return verifyUberWebhookSignatureForSecret(rawBody, suppliedSignature, signingKey);
}

export function requirePickupAddress(value: UberAddress | null): UberAddress {
  if (!value) throw new UberDirectConfigError("Uber Direct requires an active Storefront pickup location with a complete tenant business address.");
  return value;
}
