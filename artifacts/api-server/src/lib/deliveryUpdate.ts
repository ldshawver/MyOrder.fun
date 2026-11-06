export function deliveryUpdateLabel(input: {
  deliveryMethod?: string | null;
  fulfillmentStatus?: string | null;
  departedAt?: Date | string | null;
  courierStatus?: string | null;
  courierState?: string | null;
}): string | null {
  const method = input.deliveryMethod;
  if (method !== "csr_delivery" && method !== "uber_direct") return null;
  const state = (input.fulfillmentStatus ?? "").toLowerCase();
  const courier = input.courierStatus || input.courierState || "";
  if (state === "completed" || state === "delivered" || courier === "delivered") {
    return method === "csr_delivery" ? "Delivered by your specialist." : "Delivered.";
  }
  if (method === "csr_delivery") {
    if (input.departedAt) return "Your specialist is on the way with your order.";
    if (state === "ready") return "Your order is ready. Your specialist is heading out.";
    return "Your order is being prepared for delivery.";
  }
  const uberLabels: Record<string, string> = {
    pending: "Courier requested",
    pickup: "Courier is on the way to the store",
    picked_up: "Order picked up",
    dropoff: "Courier is on the way to you",
    canceled: "Courier canceled",
    awaiting_staff_request: "Waiting for the store to request a driver",
    delivery_create_pending: "Driver request is going out",
    delivery_created: "Driver requested",
    payment_pending: "Delivery starts after payment",
    reconciliation_required: "Driver status is being checked",
  };
  if (uberLabels[courier]) return uberLabels[courier];
  if (state === "ready") return "Ready for the driver.";
  return "Delivery updates appear here as the order moves.";
}
