import { z } from "zod";
import { db, catalogItemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ─── Strict input contract ─────────────────────────────────────────────────────
// Lines coming in over the wire MUST contain only catalogItemId + quantity.
// Any additional field (unitPrice, total, sku, merchantName, etc.) is rejected
// so a malicious or buggy client cannot influence pricing or merchant routing.
export const CartLineInput = z
  .object({
    catalogItemId: z.number().int().positive(),
    quantity: z.number().int().positive(),
  })
  .strict();

export type CartLineInputType = z.infer<typeof CartLineInput>;

const CartInputSchema = z.array(CartLineInput).min(1);

export interface NormalizedCartLine {
  catalog_item_id: number;
  source_type: "local_mapped" | "woo";
  // Discriminator from `catalog_items.merchant_brand`. Alavont lines are
  // re-written to a Lucifer Cruz merchant line by this function before they
  // ever reach the payment processor.
  merchant_brand: "alavont" | "lucifer_cruz";
  catalog_display_name: string;
  merchant_name: string;
  merchant_sku: string | null;
  receipt_alavont_name: string;
  receipt_lucifer_name: string;
  merchant_image_url: string | null;
  unit_price: number;
  quantity: number;
  line_subtotal: number;
  alavont_id: string | null;
  woo_product_id: string | null;
  woo_variation_id: string | null;
  lab_name: string | null;
  receipt_name: string | null;
  label_name: string | null;
}

export interface CheckoutTotals {
  subtotal: number;
  tax: number;
  total: number;
  taxRate: number;
}

// Tax rule lives here so the server is the single source of truth — clients
// are never trusted with totals. (Out of scope for Task #13: changing the rate.)
export const CHECKOUT_TAX_RATE = 0.08;

// Thrown when an Alavont catalog item has no resolvable Lucifer Cruz merchant
// mapping. Carries the offending catalogItemId so the route layer can shape
// the spec'd 422 JSON response and write the audit row.
export class CheckoutMappingError extends Error {
  public readonly catalogItemId: number;
  public readonly reason: string;
  constructor(catalogItemId: number, reason: string, message?: string) {
    super(message ?? `Catalog item ${catalogItemId} cannot be mapped to a Lucifer Cruz merchant line: ${reason}`);
    this.name = "CheckoutMappingError";
    this.catalogItemId = catalogItemId;
    this.reason = reason;
  }
}

function inferMerchantBrand(ci: typeof catalogItemsTable.$inferSelect): "alavont" | "lucifer_cruz" {
  // Persisted column is the source of truth. Fall back to historical flags
  // for rows that pre-date the merchant_brand column.
  const persisted = (ci as { merchantBrand?: string | null }).merchantBrand;
  if (persisted === "alavont" || persisted === "lucifer_cruz") return persisted;
  return ci.isWooManaged ? "lucifer_cruz" : "alavont";
}

export async function normalizeCheckoutCart(
  rawLines: CartLineInputType[],
  receiptMode?: string
): Promise<NormalizedCartLine[]> {
  const parsed = CartInputSchema.safeParse(rawLines);
  if (!parsed.success) {
    throw new Error(`Invalid cart input: ${parsed.error.message}`);
  }

  const normalized: NormalizedCartLine[] = [];

  for (const line of parsed.data) {
    const [ci] = await db
      .select()
      .from(catalogItemsTable)
      .where(eq(catalogItemsTable.id, line.catalogItemId))
      .limit(1);

    if (!ci) {
      throw new CheckoutMappingError(line.catalogItemId, "catalog_item_not_found",
        `Catalog item ${line.catalogItemId} not found`);
    }

    if (ci.isAvailable === false) {
      throw new CheckoutMappingError(line.catalogItemId, "item_unavailable",
        `Catalog item ${line.catalogItemId} is not available for purchase`);
    }

    const merchantBrand = inferMerchantBrand(ci);
    const isWooManaged = ci.isWooManaged === true;
    const source_type: "local_mapped" | "woo" = isWooManaged ? "woo" : "local_mapped";

    // ── Universal Alavont → Lucifer Cruz enforcement ────────────────────────
    // Every line whose persisted merchant_brand is "alavont" MUST resolve to
    // a complete Lucifer Cruz merchant identity (BOTH the LC display name
    // AND a true LC merchant SKU) before we allow any downstream payment
    // payload to be built. The `merchantProcessingMode` column is free-text
    // and not validated by an enum, so we deliberately do NOT gate on it —
    // the reviewer pinned this as the "all alavont items convert" invariant.
    // The only supported processing modes for Alavont items today are
    // "mapped_lucifer" and "comp_only"; anything else is a config drift and
    // is hard-failed below.
    if (merchantBrand === "alavont") {
      const mode = ci.merchantProcessingMode ?? "mapped_lucifer";
      const SUPPORTED_ALAVONT_MODES = new Set(["mapped_lucifer", "comp_only"]);
      if (!SUPPORTED_ALAVONT_MODES.has(mode)) {
        throw new CheckoutMappingError(line.catalogItemId, "unsupported_processing_mode",
          `Alavont catalog item ${line.catalogItemId} has unsupported merchant_processing_mode="${mode}". ` +
          `Refusing to build a payment until this row is reclassified.`);
      }
      if (!ci.luciferCruzName) {
        throw new CheckoutMappingError(line.catalogItemId, "missing_lucifer_cruz_name",
          `Alavont catalog item ${line.catalogItemId} has no lucifer_cruz_name — cannot be processed safely.`);
      }
      if (!ci.merchantSku) {
        throw new CheckoutMappingError(line.catalogItemId, "missing_merchant_sku",
          `Alavont catalog item ${line.catalogItemId} has no merchant_sku — Lucifer Cruz mapping is incomplete.`);
      }
      // The merchant_sku must be a TRUE Lucifer Cruz SKU. If it equals the
      // Alavont-side identifier (alavont_id) or carries the well-known
      // Alavont-shape prefixes, the row was not properly remapped — refuse
      // to build a payment for it. Stops Alavont identifiers leaking into
      // the Stripe payload via the merchant_sku field.
      if (
        (ci.alavontId && ci.merchantSku === ci.alavontId) ||
        /^(?:ALV|ALAVONT)[-_]/i.test(ci.merchantSku)
      ) {
        throw new CheckoutMappingError(line.catalogItemId, "alavont_shaped_merchant_sku",
          `Alavont catalog item ${line.catalogItemId} has merchant_sku "${ci.merchantSku}" that looks like an Alavont identifier. ` +
          `Remap to a true Lucifer Cruz SKU before processing payments.`);
      }
    }

    if (source_type === "woo") {
      if (!ci.wooProductId) {
        throw new CheckoutMappingError(line.catalogItemId, "missing_woo_product_id",
          `Catalog item ${line.catalogItemId} has is_woo_managed=true but missing woo_product_id. ` +
          `Cannot route to WooCommerce without a product ID.`);
      }
    }

    const catalog_display_name = ci.alavontName ?? ci.name;
    // For Alavont brand, ci.luciferCruzName is guaranteed non-null by the
    // unconditional check above — never fall back to ci.name (which can be
    // an Alavont string and would leak into the Stripe payload).
    const merchant_name =
      merchantBrand === "alavont"
        ? ci.luciferCruzName!
        : (ci.luciferCruzName ?? ci.name);
    const receipt_alavont_name = ci.alavontName ?? ci.name;
    const receipt_lucifer_name = ci.luciferCruzName ?? ci.name;
    const merchant_image_url =
      source_type === "woo"
        ? (ci.luciferCruzImageUrl ?? ci.imageUrl ?? null)
        : (ci.luciferCruzImageUrl ?? null);
    // For Alavont brand, merchant_sku is guaranteed non-null and validated
    // above — never fall back to ci.sku/ci.wooProductId (which may carry
    // Alavont-side identifiers for that row).
    const merchant_sku =
      merchantBrand === "alavont"
        ? ci.merchantSku!
        : (ci.merchantSku ?? ci.wooProductId ?? ci.sku ?? null);

    const unit_price = parseFloat(ci.price as string);
    const line_subtotal = parseFloat((unit_price * line.quantity).toFixed(2));

    const normalizedLine: NormalizedCartLine = {
      catalog_item_id: ci.id,
      source_type,
      merchant_brand: merchantBrand,
      catalog_display_name,
      merchant_name,
      merchant_sku,
      receipt_alavont_name,
      receipt_lucifer_name,
      merchant_image_url,
      unit_price,
      quantity: line.quantity,
      line_subtotal,
      alavont_id: ci.alavontId ?? null,
      woo_product_id: ci.wooProductId ?? null,
      woo_variation_id: ci.wooVariationId ?? null,
      lab_name: ci.labName ?? null,
      receipt_name: ci.receiptName ?? null,
      label_name: ci.labelName ?? null,
    };

    logger.info({
      event: "checkout_normalization",
      cart_item_id: line.catalogItemId,
      source_type,
      merchant_brand: merchantBrand,
      catalog_display_name,
      merchant_name,
      receipt_mode: receiptMode ?? "not_specified",
    }, "Cart line normalized");

    normalized.push(normalizedLine);
  }

  return normalized;
}

// Server-side authoritative totals. Clients NEVER supply these — any
// unitPrice/total in the request is rejected by the strict CartLineInput
// schema, and the order's subtotal/tax/total is rederived here from DB prices.
export function computeCheckoutTotals(lines: NormalizedCartLine[]): CheckoutTotals {
  const subtotal = parseFloat(lines.reduce((s, l) => s + l.line_subtotal, 0).toFixed(2));
  const tax = parseFloat((subtotal * CHECKOUT_TAX_RATE).toFixed(2));
  const total = parseFloat((subtotal + tax).toFixed(2));
  return { subtotal, tax, total, taxRate: CHECKOUT_TAX_RATE };
}

export function buildMerchantPayloadLines(
  normalizedLines: NormalizedCartLine[],
  merchantImageEnabled = true
): Array<{
  name: string;
  image_url: string | null;
  quantity: number;
  unit_price: number;
  total_price: number;
  source_type: string;
  merchant_sku: string | null;
  woo_product_id: string | null;
  woo_variation_id: string | null;
}> {
  return normalizedLines.map(line => ({
    name: line.merchant_name,
    image_url: merchantImageEnabled ? line.merchant_image_url : null,
    quantity: line.quantity,
    unit_price: line.unit_price,
    total_price: parseFloat((line.unit_price * line.quantity).toFixed(2)),
    source_type: line.source_type,
    merchant_sku: line.merchant_sku,
    woo_product_id: line.woo_product_id,
    woo_variation_id: line.woo_variation_id,
  }));
}

export function buildReceiptLines(
  normalizedLines: NormalizedCartLine[],
  receiptLineNameMode: "alavont_only" | "lucifer_only" | "both"
): Array<{ name: string; quantity: number; unit_price: number; lab_name: string | null }> {
  const result: Array<{ name: string; quantity: number; unit_price: number; lab_name: string | null }> = [];
  for (const line of normalizedLines) {
    if (receiptLineNameMode === "alavont_only") {
      result.push({
        name: line.receipt_alavont_name,
        quantity: line.quantity,
        unit_price: line.unit_price,
        lab_name: line.lab_name,
      });
    } else if (receiptLineNameMode === "lucifer_only") {
      result.push({
        name: line.receipt_lucifer_name,
        quantity: line.quantity,
        unit_price: line.unit_price,
        lab_name: line.lab_name,
      });
    } else {
      result.push({
        name: line.receipt_alavont_name,
        quantity: line.quantity,
        unit_price: line.unit_price,
        lab_name: line.lab_name,
      });
      if (line.receipt_lucifer_name !== line.receipt_alavont_name) {
        result.push({
          name: `LC: ${line.receipt_lucifer_name}`,
          quantity: line.quantity,
          unit_price: 0,
          lab_name: null,
        });
      }
    }
  }
  return result;
}
