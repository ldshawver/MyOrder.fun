export function staffFulfillmentAction(orderId: number, status: "in_progress" | "preparing" | "ready" | "completed", isAdmin: boolean): {
  endpoint: string;
  body?: { fulfillmentStatus?: string };
} {
  if (status === "in_progress") {
    return isAdmin
      ? { endpoint: `/api/orders/${orderId}/fulfillment`, body: { fulfillmentStatus: status } }
      : { endpoint: `/api/orders/${orderId}/claim`, body: {} };
  }
  if (status === "completed") return { endpoint: `/api/orders/${orderId}/complete` };
  return {
    endpoint: `/api/orders/${orderId}/${status === "preparing" ? "prepare" : "ready"}`,
    body: { fulfillmentStatus: status },
  };
}
