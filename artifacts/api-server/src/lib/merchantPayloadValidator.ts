import type { NormalizedCartLine } from "./checkoutNormalizer";
export class MerchantPayloadValidationError extends Error {
  public readonly missingSafeFields?: string[];
  constructor(message = "Merchant payload must use Safe fields only", missingSafeFields?: string[]) {
    super(message);
    this.name = "MerchantPayloadValidationError";
    this.missingSafeFields = missingSafeFields;
  }
}
export function assertSafeMerchantLines(lines: NormalizedCartLine[]): void {
  for (const line of lines) {
    const required = {
      customer_safe_name: line.customer_safe_name,
      customer_safe_description: line.customer_safe_description,
      customer_safe_category: line.customer_safe_category,
      customer_safe_image: line.customer_safe_image,
    };
    const missingSafeFields = Object.entries(required)
      .filter(([, value]) => typeof value !== "string" || value.trim().length === 0)
      .map(([field]) => field);
    if (missingSafeFields.length > 0) {
      throw new MerchantPayloadValidationError(`Missing safe merchant field: ${missingSafeFields.join(", ")}`, missingSafeFields);
    }
    const forbidden = [line.receipt_alavont_name, line.display_description, line.display_category].filter(Boolean).map(String);
    const safe = [line.customer_safe_name, line.customer_safe_description, line.customer_safe_category, line.customer_safe_image].join("\n").toLowerCase();
    for (const f of forbidden) if (f && ![line.customer_safe_name,line.customer_safe_description,line.customer_safe_category].includes(f) && safe.includes(f.toLowerCase())) throw new MerchantPayloadValidationError();
  }
}
export function buildSafeMerchantPayloadLines(lines: NormalizedCartLine[]) {
  assertSafeMerchantLines(lines);
  return lines.map(line => ({ name: line.customer_safe_name, description: line.customer_safe_description, category: line.customer_safe_category, image_url: line.customer_safe_image, quantity: line.quantity, unit_price: line.unit_price, total_price: Number((line.unit_price * line.quantity).toFixed(2)), source_type: line.source_type, merchant_sku: line.merchant_sku, woo_product_id: line.woo_product_id, woo_variation_id: line.woo_variation_id }));
}
