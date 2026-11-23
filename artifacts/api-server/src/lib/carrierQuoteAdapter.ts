import { z } from "zod";

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
