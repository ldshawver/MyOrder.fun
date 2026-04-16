import { z } from "zod";
import { db, catalogItemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export const CartLineInput = z.object({
  catalogItemId: z.number(),
  quantity: z.number().int().positive(),
});

export type CartLineInputType = z.infer<typeof CartLineInput>;

export interface NormalizedCartLine {
  catalog_item_id: number;
  source_type: "local_mapped" | "woo";
  catalog_display_name: string;
  merchant_name: string;
  receipt_alavont_name: string;
  receipt_lucifer_name: string;
  merchant_image_url: string | null;
  unit_price: number;
  quantity: number;
  alavont_id: string | null;
  woo_product_id: string | null;
  woo_variation_id: string | null;
  lab_name: string | null;
  receipt_name: string | null;
  label_name: string | null;
}

const CartInputSchema = z.array(CartLineInput);

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
      throw new Error(`Catalog item ${line.catalogItemId} not found`);
    }

    const isWooManaged = ci.isWooManaged === true;
    const merchantProcessingMode = ci.merchantProcessingMode ?? "mapped_lucifer";
    const source_type: "local_mapped" | "woo" = isWooManaged ? "woo" : "local_mapped";

    if (source_type === "local_mapped" && merchantProcessingMode === "mapped_lucifer") {
      const merchantName = ci.luciferCruzName;
      if (!merchantName) {
        throw new Error(
          `Catalog item ${line.catalogItemId} has merchant_processing_mode=mapped_lucifer but missing lucifer_cruz_name. ` +
          `This item cannot be processed safely.`
        );
      }
    }

    if (source_type === "woo") {
      if (!ci.wooProductId) {
        throw new Error(
          `Catalog item ${line.catalogItemId} has is_woo_managed=true but missing woo_product_id. ` +
          `Cannot route to WooCommerce without a product ID.`
        );
      }
    }

    const catalog_display_name = ci.alavontName ?? ci.name;
    const merchant_name =
      source_type === "woo"
        ? (ci.luciferCruzName ?? ci.name)
        : (ci.luciferCruzName ?? ci.name);
    const receipt_alavont_name = ci.alavontName ?? ci.name;
    const receipt_lucifer_name = ci.luciferCruzName ?? ci.name;
    const merchant_image_url =
      source_type === "woo"
        ? (ci.luciferCruzImageUrl ?? ci.imageUrl ?? null)
        : (ci.luciferCruzImageUrl ?? null);

    const normalizedLine: NormalizedCartLine = {
      catalog_item_id: ci.id,
      source_type,
      catalog_display_name,
      merchant_name,
      receipt_alavont_name,
      receipt_lucifer_name,
      merchant_image_url,
      unit_price: parseFloat(ci.price as string),
      quantity: line.quantity,
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
      catalog_display_name,
      merchant_name,
      receipt_mode: receiptMode ?? "not_specified",
    }, "Cart line normalized");

    normalized.push(normalizedLine);
  }

  return normalized;
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
