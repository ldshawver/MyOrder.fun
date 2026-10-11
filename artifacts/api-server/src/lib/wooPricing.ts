export type WooPriceMapping = { price: string; compareAtPrice: string | null };

/**
 * WooCommerce's `price` is its effective price (including an active sale).
 * The database stores currency amounts at scale 2, so reject malformed or
 * unrepresentable values instead of silently substituting zero or using a
 * binary floating-point conversion.
 */
export function mapWooSellingPrice(input: {
  price?: string | null;
  regularPrice?: string | null;
  salePrice?: string | null;
  currency: string;
}): WooPriceMapping {
  // MyOrder's tenant currency contract currently supports USD only. Never
  // import a store priced in a different currency and imply conversion.
  if (input.currency !== "USD") throw new Error("unsupported_currency_configuration");
  const effective = input.price?.trim();
  if (!effective || !/^\d{1,8}(?:\.\d{1,6})?$/.test(effective)) throw new Error("woo_price_missing_or_invalid");
  const price = toTwoDecimals(effective);
  const regular = input.regularPrice?.trim();
  const regularPrice = regular && /^\d{1,8}(?:\.\d{1,6})?$/.test(regular) ? toTwoDecimals(regular) : null;
  const effectiveCents = BigInt(price.replace(".", ""));
  const regularCents = regularPrice === null ? null : BigInt(regularPrice.replace(".", ""));
  return {
    price,
    compareAtPrice: regularCents !== null && regularCents > effectiveCents ? regularPrice : null,
  };
}

function toTwoDecimals(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const padded = `${fraction}000`;
  const cents = BigInt(padded.slice(0, 2));
  const roundDigit = Number(padded[2]);
  const rounded = BigInt(whole) * 100n + cents + (roundDigit >= 5 ? 1n : 0n);
  const dollars = rounded / 100n;
  const remainder = String(rounded % 100n).padStart(2, "0");
  if (dollars > 99_999_999n) throw new Error("woo_price_out_of_range");
  return `${dollars}.${remainder}`;
}
