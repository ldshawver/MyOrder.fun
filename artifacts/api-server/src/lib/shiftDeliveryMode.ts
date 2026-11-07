export type ShiftDeliveryMode = "personal" | "uber";

export function shiftDeliveryMode(input: { csrDeliveryOptIn?: boolean | null; setupJson?: unknown }): ShiftDeliveryMode | null {
  const setup = input.setupJson && typeof input.setupJson === "object" ? input.setupJson as Record<string, unknown> : {};
  if (setup.deliveryMode === "personal" || setup.deliveryMode === "uber") return setup.deliveryMode;
  if (input.csrDeliveryOptIn === true || setup.csrDeliveryOptIn === true) return "personal";
  return null;
}

/**
 * Customers choose pickup or delivery. The specialist's shift decides whether
 * delivery is personal or Uber. Any non-pickup request follows that shift.
 */
export function resolveCustomerFulfillment(
  requested: string | null | undefined,
  mode: ShiftDeliveryMode | null,
): { method: "pickup" | "csr_delivery" | "uber_direct" } | { error: string } {
  const value = requested && requested.length > 0 ? requested : "pickup";
  if (value === "pickup") return { method: "pickup" };
  if (mode === "personal") return { method: "csr_delivery" };
  if (mode === "uber") return { method: "uber_direct" };
  return { error: "Delivery is set by the specialist on shift. Pickup is available." };
}
