import crypto from "node:crypto";
import { z } from "zod";
import { db, ordersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { computeBaseCheckoutTotals, computeCheckoutTotals, normalizeCheckoutCart, type CartLineInputType, type NormalizedCartLine } from "./checkoutNormalizer";

export const CHECKOUT_CONVERSION_REQUIRED_MESSAGE = "Checkout needs to be prepared before payment";
export const CHECKOUT_CONVERSION_TTL_MS = 15 * 60 * 1000;

export class CheckoutConversionRequiredError extends Error {
  status = 422;
  constructor() { super(CHECKOUT_CONVERSION_REQUIRED_MESSAGE); this.name = "CheckoutConversionRequiredError"; }
}

const TokenPayload = z.object({ tenantId: z.number().int().positive(), userId: z.number().int().positive(), issuedAt: z.string(), expiresAt: z.string(), items: z.array(z.object({ catalogItemId: z.number().int().positive(), quantity: z.number().int().positive() })).min(1), snapshotHash: z.string().min(16) });
export type CheckoutConversionTokenPayload = z.infer<typeof TokenPayload>;
const TaxQuotePayload = z.object({
  tenantId: z.number().int().positive(), userId: z.number().int().positive(), cartFingerprint: z.string().length(64),
  // Tax is determined by merchandise and location, not by the payment source.
  locationId: z.number().int().positive().nullable(),
  taxConfigurationId: z.number().int().positive(), taxRate: z.number().finite().min(0).max(1),
  taxableBaseCents: z.number().int().nonnegative(), taxCents: z.number().int().nonnegative(),
  issuedAt: z.string().datetime(), expiresAt: z.string().datetime(),
});
export type CheckoutTaxQuoteContext = Pick<z.infer<typeof TaxQuotePayload>, "tenantId" | "userId" | "cartFingerprint" | "locationId" | "taxConfigurationId" | "taxRate" | "taxableBaseCents" | "taxCents">;
export const CHECKOUT_TAX_QUOTE_TTL_MS = 5 * 60 * 1000;

function secret(): string { return process.env.CHECKOUT_CONVERSION_SECRET || process.env.SESSION_SECRET || "dev-checkout-conversion-secret"; }
function stripTransportConversionFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const clone = { ...(value as Record<string, unknown>) };
  delete clone.checkoutConversionToken;
  delete clone.conversionToken;
  delete clone.conversionExpiresAt;
  delete clone.snapshotHash;
  return clone;
}
export function hashConversionSnapshot(snapshot: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(stripTransportConversionFields(snapshot))).digest("hex"); }
export function signCheckoutConversion(payload: CheckoutConversionTokenPayload): string { const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url"); const sig = crypto.createHmac("sha256", secret()).update(encoded).digest("base64url"); return `${encoded}.${sig}`; }
function parseToken(token: unknown): CheckoutConversionTokenPayload { if (typeof token !== "string" || !token.includes(".")) throw new CheckoutConversionRequiredError(); const [encoded, sig] = token.split("."); const expected = crypto.createHmac("sha256", secret()).update(encoded).digest("base64url"); if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new CheckoutConversionRequiredError(); const parsed = TokenPayload.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))); if (!parsed.success) throw new CheckoutConversionRequiredError(); return parsed.data; }
function itemsKey(items: CartLineInputType[]): string { return JSON.stringify([...items].map(i => ({ catalogItemId: i.catalogItemId, quantity: i.quantity })).sort((a,b) => a.catalogItemId - b.catalogItemId)); }

export async function createVerifiedCheckoutConversionToken(input: { tenantId: number; userId: number; items: CartLineInputType[]; snapshot: unknown; now?: Date }): Promise<{ checkoutConversionToken: string; conversionExpiresAt: string; snapshotHash: string }> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CHECKOUT_CONVERSION_TTL_MS).toISOString();
  const snapshotHash = hashConversionSnapshot(input.snapshot);
  return { checkoutConversionToken: signCheckoutConversion({ tenantId: input.tenantId, userId: input.userId, issuedAt: now.toISOString(), expiresAt, items: input.items, snapshotHash }), conversionExpiresAt: expiresAt, snapshotHash };
}

export function createCheckoutTaxQuoteToken(input: CheckoutTaxQuoteContext & { now?: Date }): string {
  const now = input.now ?? new Date();
  const payload = TaxQuotePayload.parse({
    tenantId: input.tenantId, userId: input.userId, cartFingerprint: input.cartFingerprint,
    locationId: input.locationId, taxConfigurationId: input.taxConfigurationId,
    taxRate: input.taxRate, taxableBaseCents: input.taxableBaseCents, taxCents: input.taxCents,
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + CHECKOUT_TAX_QUOTE_TTL_MS).toISOString(),
  });
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyCheckoutTaxQuoteToken(token: unknown, expected: CheckoutTaxQuoteContext, now = new Date()): boolean {
  try {
    if (typeof token !== "string") return false;
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra !== undefined) return false;
    const expectedSignature = crypto.createHmac("sha256", secret()).update(encoded).digest();
    const actualSignature = Buffer.from(signature, "base64url");
    if (actualSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(actualSignature, expectedSignature)) return false;
    const parsed = TaxQuotePayload.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (!parsed.success || new Date(parsed.data.expiresAt).getTime() <= now.getTime()) return false;
    const quote = parsed.data;
    return quote.tenantId === expected.tenantId && quote.userId === expected.userId
      && quote.cartFingerprint === expected.cartFingerprint
      && quote.locationId === expected.locationId && quote.taxConfigurationId === expected.taxConfigurationId
      && quote.taxRate === expected.taxRate && quote.taxableBaseCents === expected.taxableBaseCents
      && quote.taxCents === expected.taxCents;
  } catch { return false; }
}

export async function requireVerifiedCheckoutConversion(input: { tenantId: number; userId: number; checkoutConversionToken?: unknown; requestedItems: CartLineInputType[]; legalDisclaimerAccepted?: boolean; finalConfirmationAt?: unknown; snapshot?: unknown }): Promise<{ lines: NormalizedCartLine[]; totals: ReturnType<typeof computeCheckoutTotals>; conversionExpiresAt: Date; snapshot: unknown }> {
  try {
    if (input.legalDisclaimerAccepted !== true) throw new CheckoutConversionRequiredError();
    if (!input.finalConfirmationAt || Number.isNaN(new Date(String(input.finalConfirmationAt)).getTime())) throw new CheckoutConversionRequiredError();
    const payload = parseToken(input.checkoutConversionToken);
    if (payload.tenantId !== input.tenantId || payload.userId !== input.userId) throw new CheckoutConversionRequiredError();
    const expiresAt = new Date(payload.expiresAt);
    if (expiresAt.getTime() <= Date.now()) throw new CheckoutConversionRequiredError();
    if (itemsKey(payload.items) !== itemsKey(input.requestedItems)) throw new CheckoutConversionRequiredError();
    if (!input.snapshot || hashConversionSnapshot(input.snapshot) !== payload.snapshotHash) throw new CheckoutConversionRequiredError();
    const lines = await normalizeCheckoutCart(input.requestedItems, undefined, true, input.tenantId);
    const totals = computeBaseCheckoutTotals(lines);
    return { lines, totals, conversionExpiresAt: expiresAt, snapshot: input.snapshot };
  } catch (err) { if (err instanceof CheckoutConversionRequiredError) throw err; throw new CheckoutConversionRequiredError(); }
}

export async function requireOrderHasVerifiedCheckoutConversion(tenantId: number, orderId: number): Promise<void> {
  const [order] = await db.select().from(ordersTable).where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.id, orderId))).limit(1);
  if (!order?.legalDisclaimerAccepted || !order.finalConfirmationAt || !order.checkoutConversionSnapshot || !order.checkoutConversionExpiresAt) throw new CheckoutConversionRequiredError();
  if (new Date(order.checkoutConversionExpiresAt as Date).getTime() <= Date.now()) throw new CheckoutConversionRequiredError();
}

export function sendCheckoutConversionRequired(res: { status: (code: number) => { json: (body: unknown) => void } }): void { res.status(422).json({ error: CHECKOUT_CONVERSION_REQUIRED_MESSAGE }); }
