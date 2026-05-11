// Centralized Stripe payment-intent payload builder.
//
// Task #13 contract: every value sent to Stripe — `description`, `metadata`,
// `statement_descriptor_suffix` — must contain ONLY Lucifer Cruz merchant
// strings. Alavont catalog names, SKUs, and ids are forbidden from leaking
// into the payment processor's records.
//
// Routes that talk to Stripe MUST go through this builder so a single audit
// surface guarantees the property. The companion vitest case asserts that no
// Alavont string can survive the build step.

import type { NormalizedCartLine } from "./checkoutNormalizer";

export interface StripeIntentPayloadInput {
  orderId: number;
  amount: number;       // dollars (will be converted to cents)
  currency: string;
  lines: NormalizedCartLine[];
}

export interface StripeIntentPayload {
  amount: number;       // cents — ready for stripe.paymentIntents.create
  currency: string;
  description: string;
  metadata: Record<string, string>;
  statement_descriptor_suffix: string;
}

// Stripe's statement_descriptor_suffix has a 22-char limit and may not
// include `< > \ ' " *`. We hard-code the LC merchant suffix here so the
// processor's billing record on a customer's bank statement is always the
// LC brand, not Alavont.
export const LUCIFER_CRUZ_STATEMENT_SUFFIX = "LCRUZ ORDER";
export const STRIPE_DESCRIPTION_MAX = 500;
export const STRIPE_METADATA_VALUE_MAX = 490;

function summarizeMerchantLines(lines: NormalizedCartLine[]): string {
  return lines.map(l => `${l.merchant_name} x${l.quantity}`).join(", ");
}

// SKUs that look like Alavont identifiers (the well-known ALV-/ALAVONT-
// prefixes, or anything that exactly matches the line's alavont_id) MUST
// NOT be forwarded to Stripe. The normalizer already rejects these at the
// catalog layer, but we apply the same filter here so a bug in either
// layer alone cannot produce a leak.
function looksLikeAlavontId(candidate: string, line: NormalizedCartLine): boolean {
  if (line.alavont_id && candidate === line.alavont_id) return true;
  return /^(?:ALV|ALAVONT)[-_]/i.test(candidate);
}

function summarizeMerchantSkus(lines: NormalizedCartLine[]): string {
  return lines
    .map(l => {
      if (l.merchant_sku && !looksLikeAlavontId(l.merchant_sku, l)) return l.merchant_sku;
      if (l.woo_product_id && !looksLikeAlavontId(l.woo_product_id, l)) return l.woo_product_id;
      return `cid:${l.catalog_item_id}`;
    })
    .join(",");
}

export function buildStripeIntentPayload(input: StripeIntentPayloadInput): StripeIntentPayload {
  const linesSummary = summarizeMerchantLines(input.lines);
  const skuSummary = summarizeMerchantSkus(input.lines);

  // Description shows up on the Stripe Dashboard line — LC names only.
  const description = `Lucifer Cruz Order #${input.orderId}${linesSummary ? ` — ${linesSummary}` : ""}`
    .slice(0, STRIPE_DESCRIPTION_MAX);

  // Metadata is preserved on the PaymentIntent forever. Keep it merchant-safe.
  const metadata: Record<string, string> = {
    orderId: String(input.orderId),
    merchantBrand: "lucifer_cruz",
    merchantLines: linesSummary.slice(0, STRIPE_METADATA_VALUE_MAX),
    merchantSkus: skuSummary.slice(0, STRIPE_METADATA_VALUE_MAX),
    lineCount: String(input.lines.length),
  };

  return {
    amount: Math.round(input.amount * 100),
    currency: input.currency,
    description,
    metadata,
    statement_descriptor_suffix: LUCIFER_CRUZ_STATEMENT_SUFFIX,
  };
}

// Audit helper for tests + the merchant-payload-preview route. Returns true if
// any field of the Stripe payload contains an Alavont string from the original
// normalized lines.
export function payloadContainsAlavontLeak(
  payload: StripeIntentPayload,
  lines: NormalizedCartLine[]
): { leaked: boolean; offenders: string[] } {
  const haystack = [
    payload.description,
    payload.statement_descriptor_suffix,
    ...Object.values(payload.metadata),
  ].join("\n").toLowerCase();

  const offenders: string[] = [];
  for (const line of lines) {
    const candidates = [line.receipt_alavont_name, line.alavont_id]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      // Alavont string is only an offender when it differs from the LC name —
      // otherwise the merchant catalog literally uses the same string.
      .filter(s => s.toLowerCase() !== line.merchant_name.toLowerCase());
    for (const candidate of candidates) {
      if (haystack.includes(candidate.toLowerCase())) offenders.push(candidate);
    }
  }
  return { leaked: offenders.length > 0, offenders: [...new Set(offenders)] };
}
