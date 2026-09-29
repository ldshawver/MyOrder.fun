export type SellableOption = {
  id: number;
  catalogItemId: number;
  label: string;
  price: string;
  sku: string | null;
};

export type SellableProduct = {
  id: number;
  name: string;
  options: SellableOption[];
};

export function selectedSellableOption(product: SellableProduct | undefined, selectedId: number | null): SellableOption | undefined {
  return product?.options.find(option => option.id === selectedId) ?? product?.options[0];
}

export function showOptionSelector(product: SellableProduct | undefined): boolean {
  return (product?.options.length ?? 0) > 1;
}

export function optionCartEntry(product: SellableProduct, option: SellableOption, imageUrl: string | null) {
  if (!product.options.some(candidate => candidate.id === option.id)) throw new Error("Option does not belong to product");
  return {
    id: option.catalogItemId,
    optionId: option.id,
    name: `${product.name}${showOptionSelector(product) ? ` — ${option.label}` : ""}`,
    price: Number(option.price),
    imageUrl,
  };
}

export function checkoutOptionLines(cart: Array<{ optionId?: number; id: number; quantity: number }>) {
  return cart.map(item => item.optionId
    ? { optionId: item.optionId, quantity: item.quantity }
    : { catalogItemId: item.id, quantity: item.quantity });
}
