type CheckoutMappingResponse = {
  error?: unknown;
  code?: unknown;
  catalogItemId?: unknown;
};

export function checkoutPreparationError(data: unknown, cart: Array<{ id: number; name: string }>): string {
  if (!data || typeof data !== "object") return "Could not prepare checkout.";
  const response = data as CheckoutMappingResponse;
  if (response.code === "CHECKOUT_MAPPING_REQUIRED" && Number.isInteger(response.catalogItemId)) {
    const item = cart.find(candidate => candidate.id === response.catalogItemId);
    const itemName = item?.name ?? "This item";
    return `${itemName} needs verified checkout details before it can be purchased. Remove it from your cart or contact the store.`;
  }
  return typeof response.error === "string" ? response.error : "Could not prepare checkout.";
}
