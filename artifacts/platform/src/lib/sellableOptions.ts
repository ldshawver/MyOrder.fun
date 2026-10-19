export type SellableOption = {
  id: number;
  catalogItemId: number;
  label: string;
  price: string;
  sku?: string | null;
  optionValues?: Record<string, string>;
  barcode?: string | null;
};

export type SellableProduct = {
  id: number;
  name: string;
  options: SellableOption[];
};

export function selectedSellableOption(product: SellableProduct | undefined, selectedId: number | null): SellableOption | undefined {
  if (!product) return undefined;
  if (product.options.length === 1) return product.options[0];
  return selectedId === null ? undefined : product.options.find(option => option.id === selectedId);
}

export function showOptionSelector(product: SellableProduct | undefined): boolean {
  return (product?.options.length ?? 0) > 1 || optionAxes(product).length > 0;
}

export function optionAxes(product: SellableProduct | undefined): Array<{ name: string; values: string[] }> {
  if (!product) return [];
  const axes = new Map<string, Set<string>>();
  for (const option of product.options) for (const [name, value] of Object.entries(option.optionValues ?? {})) {
    if (!axes.has(name)) axes.set(name, new Set());
    axes.get(name)!.add(value);
  }
  return [...axes].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, values]) => ({ name, values: [...values].sort((a, b) => a.localeCompare(b)) }));
}

export function optionForValues(product: SellableProduct | undefined, selected: Record<string, string>): SellableOption | undefined {
  const axes = optionAxes(product);
  if (!product || !axes.length || axes.some(axis => !selected[axis.name])) return undefined;
  return product.options.find(option => axes.every(axis => option.optionValues?.[axis.name] === selected[axis.name]));
}

export function optionCartEntry(product: SellableProduct, option: SellableOption, imageUrl: string | null) {
  if (!product.options.some(candidate => candidate.id === option.id)) throw new Error("Option does not belong to product");
  return {
    id: option.catalogItemId,
    optionId: option.id,
    name: `${product.name}${showOptionSelector(product) ? ` — ${option.label}` : ""}`,
    price: Number(option.price),
    optionValues: option.optionValues ?? {},
    imageUrl,
  };
}

export function checkoutOptionLines(cart: Array<{ optionId?: number; id: number; quantity: number }>) {
  return cart.map(item => item.optionId
    ? { optionId: item.optionId, quantity: item.quantity }
    : { catalogItemId: item.id, quantity: item.quantity });
}
