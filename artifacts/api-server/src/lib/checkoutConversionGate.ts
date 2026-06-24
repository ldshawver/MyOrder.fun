import crypto from "node:crypto";
import { z } from "zod";
import { db, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { computeCheckoutTotals, normalizeCheckoutCart, type CartLineInputType, type NormalizedCartLine } from "./checkoutNormalizer";

export const CHECKOUT_CONVERSION_REQUIRED_MESSAGE = "Cart must be converted before checkout";
export const CHECKOUT_CONVERSION_TTL_MS = 15 * 60 * 1000;

export class CheckoutConversionRequiredError extends Error {
  status = 422;
  constructor() { super(CHECKOUT_CONVERSION_REQUIRED_MESSAGE); this.name = "CheckoutConversionRequiredError"; }
}

const TokenPayload = z.object({ tenantId: z.number().int().positive(), userId: z.number().int().positive(), issuedAt: z.string(), expiresAt: z.string(), items: z.array(z.object({ catalogItemId: z.number().int().positive(), quantity: z.number().int().positive() })).min(1), snapshotHash: z.string().min(16) });
export type CheckoutConversionTokenPayload = z.infer<typeof TokenPayload>;

function secret(): string { return process.env.CHECKOUT_CONVERSION_SECRET || process.env.SESSION_SECRET || "dev-checkout-conversion-secret"; }
export function hashConversionSnapshot(snapshot: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"); }
export function signCheckoutConversion(payload: CheckoutConversionTokenPayload): string { const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url"); const sig = crypto.createHmac("sha256", secret()).update(encoded).digest("base64url"); return `${encoded}.${sig}`; }
function parseToken(token: unknown): CheckoutConversionTokenPayload { if (typeof token !== "string" || !token.includes(".")) throw new CheckoutConversionRequiredError(); const [encoded, sig] = token.split("."); const expected = crypto.createHmac("sha256", secret()).update(encoded).digest("base64url"); if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new CheckoutConversionRequiredError(); const parsed = TokenPayload.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))); if (!parsed.success) throw new CheckoutConversionRequiredError(); return parsed.data; }
function itemsKey(items: CartLineInputType[]): string { return JSON.stringify([...items].map(i => ({ catalogItemId: i.catalogItemId, quantity: i.quantity })).sort((a,b) => a.catalogItemId - b.catalogItemId)); }

export async function createVerifiedCheckoutConversionToken(input: { tenantId: number; userId: number; items: CartLineInputType[]; snapshot: unknown; now?: Date }): Promise<{ checkoutConversionToken: string; conversionExpiresAt: string; snapshotHash: string }> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CHECKOUT_CONVERSION_TTL_MS).toISOString();
  const snapshotHash = hashConversionSnapshot(input.snapshot);
  return { checkoutConversionToken: signCheckoutConversion({ tenantId: input.tenantId, userId: input.userId, issuedAt: now.toISOString(), expiresAt, items: input.items, snapshotHash }), conversionExpiresAt: expiresAt, snapshotHash };
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
    const totals = computeCheckoutTotals(lines);
    return { lines, totals, conversionExpiresAt: expiresAt, snapshot: input.snapshot };
  } catch (err) { if (err instanceof CheckoutConversionRequiredError) throw err; throw new CheckoutConversionRequiredError(); }
}

export async function requireOrderHasVerifiedCheckoutConversion(orderId: number): Promise<void> {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order?.legalDisclaimerAccepted || !order.finalConfirmationAt || !order.checkoutConversionSnapshot || !order.checkoutConversionExpiresAt) throw new CheckoutConversionRequiredError();
  if (new Date(order.checkoutConversionExpiresAt as Date).getTime() <= Date.now()) throw new CheckoutConversionRequiredError();
}

export function sendCheckoutConversionRequired(res: { status: (code: number) => { json: (body: unknown) => void } }): void { res.status(422).json({ error: CHECKOUT_CONVERSION_REQUIRED_MESSAGE }); }
