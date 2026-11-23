import { z } from "zod";
import { randomUUID } from "node:crypto";
import { carrierQuotesTable, db } from "@workspace/db";

const CarrierQuoteResponse = z.object({
  quoteId: z.string().trim().min(1).max(200),
  serviceCode: z.string().trim().min(1).max(100),
  serviceName: z.string().trim().min(1).max(200),
  feeCents: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  expiresAt: z.string().datetime({ offset: true }),
  estimatedDeliveryAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export interface CarrierQuoteRequestContext {
  provider: string;
  cartFingerprint: string;
  destination: { countryCode: string; postalCode: string; address: string };
}

export interface TrustedCarrierQuote {
  provider: string;
  providerQuoteId: string;
  cartFingerprint: string;
  destinationSnapshot: CarrierQuoteRequestContext["destination"];
  serviceSnapshot: { code: string; name: string; estimatedDeliveryAt: string | null };
  feeCents: number;
  currency: string;
  expiresAt: Date;
}

export interface CarrierQuoteAdapter {
  provider: string;
  quote(context: Omit<CarrierQuoteRequestContext, "provider">): Promise<unknown>;
}

let configuredCarrierQuoteAdapter: CarrierQuoteAdapter | null = null;

/** Configure the reviewed server-side adapter during process startup. */
export function configureCarrierQuoteAdapter(adapter: CarrierQuoteAdapter | null): void {
  configuredCarrierQuoteAdapter = adapter;
}

export function requireConfiguredCarrierQuoteAdapter(): CarrierQuoteAdapter {
  if (!configuredCarrierQuoteAdapter) throw new Error("CARRIER_PROVIDER_UNAVAILABLE");
  return configuredCarrierQuoteAdapter;
}

type CarrierQuoteInsert = typeof carrierQuotesTable.$inferInsert;

export interface CreatedCarrierQuote {
  id: string;
  feeCents: number;
  currency: string;
  service: TrustedCarrierQuote["serviceSnapshot"];
  expiresAt: string;
}

/**
 * Validate a synthetic or sandbox carrier adapter response before it can be
 * persisted as checkout authority. The adapter never gets to redefine the
 * server-owned cart or destination snapshots.
 */
export function acceptCarrierQuoteResponse(
  context: CarrierQuoteRequestContext,
  response: unknown,
  now = new Date(),
): TrustedCarrierQuote {
  const provider = context.provider.trim();
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(provider)) throw new Error("CARRIER_PROVIDER_INVALID");
  if (!context.cartFingerprint.trim()) throw new Error("CARRIER_CART_INVALID");
  const destination = {
    countryCode: context.destination.countryCode.trim().toUpperCase(),
    postalCode: context.destination.postalCode.trim(),
    address: context.destination.address.trim(),
  };
  if (!/^[A-Z]{2}$/.test(destination.countryCode) || !destination.postalCode || destination.address.length < 8) {
    throw new Error("CARRIER_DESTINATION_INVALID");
  }

  const parsed = CarrierQuoteResponse.safeParse(response);
  if (!parsed.success) throw new Error("CARRIER_RESPONSE_INVALID");
  const expiresAt = new Date(parsed.data.expiresAt);
  if (expiresAt.getTime() <= now.getTime()) throw new Error("CARRIER_QUOTE_EXPIRED");
  if (parsed.data.estimatedDeliveryAt && new Date(parsed.data.estimatedDeliveryAt).getTime() < now.getTime()) {
    throw new Error("CARRIER_RESPONSE_INVALID");
  }

  return {
    provider,
    providerQuoteId: parsed.data.quoteId,
    cartFingerprint: context.cartFingerprint,
    destinationSnapshot: destination,
    serviceSnapshot: {
      code: parsed.data.serviceCode,
      name: parsed.data.serviceName,
      estimatedDeliveryAt: parsed.data.estimatedDeliveryAt ?? null,
    },
    feeCents: parsed.data.feeCents,
    currency: parsed.data.currency.toLowerCase(),
    expiresAt,
  };
}

/**
 * Invoke a configured carrier adapter and persist only the validated result.
 * Tenant/customer scope and cart/destination authority are supplied by the
 * authenticated server caller and are never accepted from the adapter.
 */
export async function createDurableCarrierQuote(
  input: {
    tenantId: number;
    customerId: number;
    cartFingerprint: string;
    destination: CarrierQuoteRequestContext["destination"];
  },
  adapter: CarrierQuoteAdapter,
  persist: (value: CarrierQuoteInsert) => Promise<void> = async value => {
    await db.insert(carrierQuotesTable).values(value);
  },
  now = new Date(),
): Promise<CreatedCarrierQuote> {
  if (!Number.isInteger(input.tenantId) || input.tenantId <= 0
    || !Number.isInteger(input.customerId) || input.customerId <= 0) {
    throw new Error("CARRIER_SCOPE_INVALID");
  }
  const context = {
    provider: adapter.provider,
    cartFingerprint: input.cartFingerprint,
    destination: input.destination,
  };
  const response = await adapter.quote({
    cartFingerprint: context.cartFingerprint,
    destination: context.destination,
  });
  const trusted = acceptCarrierQuoteResponse(context, response, now);
  const id = `carrier_${randomUUID()}`;
  await persist({
    id,
    tenantId: input.tenantId,
    customerId: input.customerId,
    provider: trusted.provider,
    providerQuoteId: trusted.providerQuoteId,
    serviceSnapshot: trusted.serviceSnapshot,
    destinationSnapshot: trusted.destinationSnapshot,
    cartFingerprint: trusted.cartFingerprint,
    feeCents: trusted.feeCents,
    currency: trusted.currency,
    status: "quoted",
    expiresAt: trusted.expiresAt,
  });
  return {
    id,
    feeCents: trusted.feeCents,
    currency: trusted.currency,
    service: trusted.serviceSnapshot,
    expiresAt: trusted.expiresAt.toISOString(),
  };
}
