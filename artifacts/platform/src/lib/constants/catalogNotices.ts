import type { Brand } from "@/contexts/BrandContext";

export const CATALOG_NOTICES: Record<Brand, string> = {
  lucifer_cruz:
    "Lucifer Cruz products are intended for adults 21+. All sales are final. Please consume responsibly and in accordance with local laws.",
  alavont:
    "Alavont items are sold subject to our standard terms. Prices, availability, and product specifications may change without notice.",
};

export function getCatalogNotice(brand: Brand): string {
  return CATALOG_NOTICES[brand];
}
