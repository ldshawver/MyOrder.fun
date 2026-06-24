import type { NormalizedCartLine } from "./checkoutNormalizer";
export class MerchantPayloadValidationError extends Error { constructor(message = "Merchant payload must use Safe fields only") { super(message); this.name = "MerchantPayloadValidationError"; } }
export function assertSafeMerchantLines(lines: NormalizedCartLine[]): void {
  for (const line of lines) {
    const required = [line.customer_safe_name, line.customer_safe_description, line.customer_safe_category, line.customer_safe_image];
    if (required.some(v => typeof v !== "string" || v.trim().length === 0)) throw new MerchantPayloadValidationError("Missing safe merchant field");
    const forbidden = [line.receipt_alavont_name, line.display_description, line.display_category].filter(Boolean).map(String);
    const safe = [line.customer_safe_name, line.customer_safe_description, line.customer_safe_category, line.customer_safe_image].join("\n").toLowerCase();
    for (const f of forbidden) if (f && ![line.customer_safe_name,line.customer_safe_description,line.customer_safe_category].includes(f) && safe.includes(f.toLowerCase())) throw new MerchantPayloadValidationError();
  }
}
export function buildSafeMerchantPayloadLines(lines: NormalizedCartLine[]) {
  assertSafeMerchantLines(lines);
  return lines.map(line => ({ name: line.customer_safe_name, description: line.customer_safe_description, category: line.customer_safe_category, image_url: line.customer_safe_image, quantity: line.quantity, unit_price: line.unit_price, total_price: Number((line.unit_price * line.quantity).toFixed(2)), source_type: line.source_type, merchant_sku: line.merchant_sku, woo_product_id: line.woo_product_id, woo_variation_id: line.woo_variation_id }));
}
