import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "./logger";

const UBER_AUTH_URL = "https://auth.uber.com/oauth/v2/token";
const UBER_API_BASE_URL = "https://api.uber.com";
const UBER_SCOPE = "eats.deliveries";

type UberToken = {
  accessToken: string;
  expiresAt: number;
};

let cachedToken: UberToken | null = null;

export type UberAddress = {
  street_address: string[];
  city?: string;
  state?: string;
  zip_code?: string;
  country: string;
};

export type UberManifestItem = {
  name: string;
  quantity: number;
  price?: number;
  size?: "small" | "medium" | "large" | "xlarge";
  replacement_type?: "contact_customer" | "remove_item" | "customer_choice";
  sku?: string;
  special_instructions?: string;
};

export function formatUberAddress(address: UberAddress): string {
  return [...address.street_address, address.city, `${address.state} ${address.zip_code}`, address.country]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
}

export type UberDeliveryQuote = {
  kind?: string;
  id: string;
  created?: string;
  expires?: string;
  fee?: number;
  currency_type?: string;
  dropoff_eta?: string;
  duration?: number;
  pickup_duration?: number;
  dropoff_deadline?: string;
  pickup_action?: string;
  manifest_items?: UberManifestItem[];
};

export class UberDirectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UberDirectConfigError";
  }
}

export class UberDirectApiError extends Error {
  public readonly status: number;
  public readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "UberDirectApiError";
    this.status = status;
    this.code = code;
  }
}

function envValue(...keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}

export function hasUberDirectConfig(): boolean {
  return Boolean(
    envValue("UBER_CLIENT_ID", "Uber_Client_ID") &&
    envValue("UBER_CLIENT_SECRET", "UBER_CLIENT_SECRET_KEY", "Uber_Client_secret") &&
    envValue("UBER_CUSTOMER_ID", "Uber_Customer_ID"),
  );
}

export function hasUberDirectWebhookConfig(): boolean {
  return Boolean(envValue("UBER_DIRECT_WEBHOOK_SIGNING_KEY"));
}

export function verifyUberWebhookSignature(rawBody: Buffer, suppliedSignature: string | undefined): boolean {
  const signingKey = envValue("UBER_DIRECT_WEBHOOK_SIGNING_KEY");
  if (!signingKey || !suppliedSignature || !/^[a-f0-9]{64}$/i.test(suppliedSignature)) return false;
  const expected = createHmac("sha256", signingKey).update(rawBody).digest("hex");
  const expectedBytes = Buffer.from(expected, "hex");
  const suppliedBytes = Buffer.from(suppliedSignature, "hex");
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function getUberConfig() {
  const clientId = envValue("UBER_CLIENT_ID", "Uber_Client_ID");
  const clientSecret = envValue("UBER_CLIENT_SECRET", "UBER_CLIENT_SECRET_KEY", "Uber_Client_secret");
  const customerId = envValue("UBER_CUSTOMER_ID", "Uber_Customer_ID");
  if (!clientId || !clientSecret || !customerId) {
    throw new UberDirectConfigError("Uber Direct credentials are not configured.");
  }
  return { clientId, clientSecret, customerId };
}

export function getConfiguredPickupAddress(): string | null {
  return envValue("UBER_PICKUP_ADDRESS", "Uber_Pickup_Address");
}

export function getUberPickupAction(): "default" | "pick_pack_pay" {
  const action = envValue("UBER_PICKUP_ACTION", "Uber_Pickup_Action");
  return action === "default" ? "default" : "pick_pack_pay";
}

export function isUberDirectDispatchEnabled(): boolean {
  return envValue("UBER_DIRECT_DISPATCH_ENABLED") === "true";
}

export function getUberPickupContact(): { name: string; phone: string } | null {
  const name = envValue("UBER_PICKUP_NAME");
  const phone = envValue("UBER_PICKUP_PHONE");
  return name && phone ? { name, phone } : null;
}

export function normalizeUberAddress(value: string | UberAddress): UberAddress {
  if (typeof value !== "string") {
    const candidate = value as Record<string, unknown>;
    const allowed = new Set(["street_address", "city", "state", "zip_code", "country"]);
    if (Object.keys(candidate).some(key => !allowed.has(key))) throw new UberDirectConfigError("A valid delivery address is required for Uber Direct.");
    return validateUberAddress({
      street_address: Array.isArray(value.street_address) ? value.street_address.map(String) : [String(value.street_address ?? "")],
      city: value.city,
      state: value.state,
      zip_code: value.zip_code,
      country: value.country || "US",
    });
  }

  const trimmed = value.trim().replace(/\u00a0/g, " ");
  if (!trimmed || trimmed.length > 300 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) throw new UberDirectConfigError("A valid delivery address is required for Uber Direct.");

  if (trimmed.startsWith("{")) {
    let parsed: Partial<UberAddress> | null;
    try { parsed = JSON.parse(trimmed) as Partial<UberAddress> | null; }
    catch { throw new UberDirectConfigError("A valid delivery address is required for Uber Direct."); }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.street_address) || Object.keys(parsed).some(key => !["street_address", "city", "state", "zip_code", "country"].includes(key))) {
      throw new UberDirectConfigError("A valid delivery address is required for Uber Direct.");
    }
    return validateUberAddress({
      street_address: parsed.street_address.map(String),
      city: parsed.city ? String(parsed.city) : undefined,
      state: parsed.state ? String(parsed.state) : undefined,
      zip_code: parsed.zip_code ? String(parsed.zip_code) : undefined,
      country: parsed.country ? String(parsed.country) : "US",
    });
  }

  const pieces = trimmed.split(",").map(piece => piece.trim()).filter(Boolean);
  if (pieces.length < 3) throw new UberDirectConfigError("Enter a complete delivery address including city, state, and postal code.");
  const last = pieces.pop()!;
  const stateZip = last.match(/^([A-Za-z]{2,3})\s+([A-Za-z0-9 -]{3,12})$/);
  if (!stateZip) throw new UberDirectConfigError("Enter a complete delivery address including city, state, and postal code.");
  return validateUberAddress({ street_address: pieces.slice(0, -1), city: pieces.at(-1), state: stateZip[1], zip_code: stateZip[2], country: "US" });
}

function validateUberAddress(value: UberAddress): UberAddress {
  const clean = (entry: unknown) => typeof entry === "string" ? entry.trim().replace(/\u00a0/g, " ") : "";
  const street = value.street_address.map(clean).filter(Boolean);
  const city = clean(value.city);
  const state = clean(value.state);
  const zip = clean(value.zip_code);
  const country = clean(value.country).toUpperCase();
  const all = [...street, city, state, zip, country];
  if (!street.length || street.length > 2 || !city || !state || !zip || !/^[A-Z]{2}$/.test(country) || all.some(entry => entry.length > 120 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(entry))) {
    throw new UberDirectConfigError("A complete, valid delivery address is required for Uber Direct.");
  }
  return { street_address: street, city, state, zip_code: zip, country };
}

async function parseUberResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function getUberAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.accessToken;
  }

  const { clientId, clientSecret } = getUberConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: UBER_SCOPE,
  });

  let res: Response;
  try { res = await fetch(UBER_AUTH_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000) }); }
  catch { throw new UberDirectApiError(502, "Uber Direct authentication is unavailable.", "oauth_unavailable"); }
  const data = await parseUberResponse(res) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data?.access_token) {
    const code = typeof data?.error === "string" ? data.error.slice(0, 80) : null;
    logger.warn({ status: res.status, code }, "Uber Direct authentication failed");
    throw new UberDirectApiError(res.status, "Uber Direct authentication failed.", code);
  }

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + Math.max(60, data.expires_in ?? 3600) * 1000,
  };
  return cachedToken.accessToken;
}

export async function createUberDeliveryQuote(input: {
  pickupAddress: string | UberAddress;
  dropoffAddress: string | UberAddress;
  manifestItems: UberManifestItem[];
  pickupAction?: "default" | "pick_pack_pay";
}): Promise<UberDeliveryQuote> {
  const { customerId } = getUberConfig();
  const token = await getUberAccessToken();
  const payload = {
    pickup_address: JSON.stringify(normalizeUberAddress(input.pickupAddress)),
    dropoff_address: JSON.stringify(normalizeUberAddress(input.dropoffAddress)),
    manifest_items: input.manifestItems,
    pickup_action: input.pickupAction ?? getUberPickupAction(),
  };

  let res: Response;
  try { res = await fetch(`${UBER_API_BASE_URL}/v1/customers/${customerId}/delivery_quotes`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) }); }
  catch { throw new UberDirectApiError(502, "Uber Direct quote service is unavailable.", "quote_unavailable"); }
  const data = await parseUberResponse(res);
  if (!res.ok) {
    const code = data && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code.slice(0, 80) : null;
    logger.warn({ status: res.status, code }, "Uber Direct quote creation failed");
    throw new UberDirectApiError(res.status, "Uber Direct quote creation failed.", code);
  }
  return data as UberDeliveryQuote;
}

export type UberDelivery = { id: string; status?: string };

export async function createUberDelivery(input: {
  quoteId: string;
  externalOrderReference: string;
  pickupAddress: UberAddress;
  pickupName: string;
  pickupPhoneNumber: string;
  dropoffAddress: UberAddress;
  dropoffName: string;
  dropoffPhoneNumber: string;
  manifestItems: UberManifestItem[];
  pickupAction?: "default" | "pick_pack_pay";
}): Promise<UberDelivery> {
  const { customerId } = getUberConfig();
  const token = await getUberAccessToken();
  const payload = {
    quote_id: input.quoteId,
    external_order_id: input.externalOrderReference,
    pickup_name: input.pickupName,
    pickup_address: JSON.stringify(input.pickupAddress),
    pickup_phone_number: input.pickupPhoneNumber,
    dropoff_name: input.dropoffName,
    dropoff_address: JSON.stringify(input.dropoffAddress),
    dropoff_phone_number: input.dropoffPhoneNumber,
    manifest_items: input.manifestItems,
    pickup_action: input.pickupAction ?? getUberPickupAction(),
  };
  let res: Response;
  try { res = await fetch(`${UBER_API_BASE_URL}/v1/customers/${customerId}/deliveries`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": input.externalOrderReference }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) }); }
  catch { throw new UberDirectApiError(502, "Uber Direct delivery service is unavailable.", "delivery_unavailable"); }
  const data = await parseUberResponse(res);
  if (!res.ok || !data || typeof data !== "object" || typeof (data as { id?: unknown }).id !== "string") {
    const code = data && typeof data === "object" && "code" in data && typeof (data as { code?: unknown }).code === "string" ? (data as { code: string }).code.slice(0, 80) : null;
    logger.warn({ status: res.status, code }, "Uber Direct delivery creation failed");
    throw new UberDirectApiError(res.status || 502, "Uber Direct delivery creation failed.", code);
  }
  return data as UberDelivery;
}
