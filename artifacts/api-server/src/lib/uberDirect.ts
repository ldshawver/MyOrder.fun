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
  public readonly details: unknown;

  constructor(status: number, message: string, details: unknown) {
    super(message);
    this.name = "UberDirectApiError";
    this.status = status;
    this.details = details;
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

function normalizeAddress(value: string | UberAddress): UberAddress {
  if (typeof value !== "string") {
    return {
      ...value,
      street_address: Array.isArray(value.street_address) ? value.street_address : [String(value.street_address ?? "")],
      country: value.country || "US",
    };
  }

  const trimmed = value.trim();
  if (!trimmed) throw new UberDirectConfigError("Delivery address is required for Uber Direct.");

  try {
    const parsed = JSON.parse(trimmed) as Partial<UberAddress> | null;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.street_address)) {
      return {
        street_address: parsed.street_address.map(String),
        city: parsed.city ? String(parsed.city) : undefined,
        state: parsed.state ? String(parsed.state) : undefined,
        zip_code: parsed.zip_code ? String(parsed.zip_code) : undefined,
        country: parsed.country ? String(parsed.country) : "US",
      };
    }
  } catch {
    // Plain text addresses are accepted and wrapped below.
  }

  return {
    street_address: [trimmed],
    city: "",
    state: "",
    zip_code: "",
    country: "US",
  };
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

  const res = await fetch(UBER_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await parseUberResponse(res) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data?.access_token) {
    logger.warn({ status: res.status, data }, "Uber Direct authentication failed");
    throw new UberDirectApiError(res.status, data?.error ?? "Uber Direct authentication failed.", data);
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
    pickup_address: JSON.stringify(normalizeAddress(input.pickupAddress)),
    dropoff_address: JSON.stringify(normalizeAddress(input.dropoffAddress)),
    manifest_items: input.manifestItems,
    pickup_action: input.pickupAction ?? getUberPickupAction(),
  };

  const res = await fetch(`${UBER_API_BASE_URL}/v1/customers/${customerId}/delivery_quotes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await parseUberResponse(res);
  if (!res.ok) {
    logger.warn({ status: res.status, data }, "Uber Direct quote creation failed");
    throw new UberDirectApiError(res.status, "Uber Direct quote creation failed.", data);
  }
  return data as UberDeliveryQuote;
}
