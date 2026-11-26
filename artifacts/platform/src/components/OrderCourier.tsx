import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";

export function useOrderCourier(orderId: number, enabled: boolean) {
  const { getToken, userId } = useAuth();
  return useQuery({
    queryKey: ["order-courier", orderId, userId],
    enabled: enabled && Boolean(userId),
    refetchInterval: query => ["delivered", "canceled", "returned"].includes(query.state.data?.courierStatus ?? "") ? false : 30_000,
    retry: false,
    queryFn: async () => {
      const token = await getToken();
      const response = await fetch(`/api/orders/${orderId}/courier`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Courier information unavailable");
      return response.json() as Promise<{
        state: string;
        courierStatus: string | null;
        driver: { name: string | null; vehicle: string | null; trackingUrl: string | null } | null;
      }>;
    },
  });
}

const statusLabels: Record<string, string> = {
  pending: "Finding a driver",
  pickup: "Driver going to pickup",
  pickup_complete: "Order picked up",
  dropoff: "Out for delivery",
  delivered: "Delivered",
  canceled: "Canceled",
  returned: "Returned",
};

export function OrderCourier({ orderId, request, complete, busy }: { orderId: number; request?: () => void; complete?: () => void; busy?: boolean }) {
  const { data } = useOrderCourier(orderId, true);
  if (!data) return null;
  const { driver } = data;
  return (
    <div className="mt-2 space-y-1 text-xs" aria-label="Uber delivery">
      <p>Uber delivery · {statusLabels[data.courierStatus ?? ""] ?? (data.state === "delivery_create_pending" ? "Request queued" : "Awaiting dispatch")}</p>
      {driver?.name && <p>Driver: {driver.name}{driver.vehicle ? ` · ${driver.vehicle}` : ""}</p>}
      {request && ["payment_pending", "awaiting_staff_request"].includes(data.state) && (
        <button type="button" disabled={busy} onClick={request} className="rounded-md bg-primary px-3 py-2 font-semibold text-primary-foreground disabled:opacity-60">Request Uber</button>
      )}
      {complete && data.courierStatus === "delivered" && (
        <button type="button" disabled={busy} onClick={complete} className="rounded-md bg-primary px-3 py-2 font-semibold text-primary-foreground disabled:opacity-60">Complete delivery</button>
      )}
      {driver?.trackingUrl && <a className="text-primary underline" href={driver.trackingUrl} target="_blank" rel="noopener noreferrer">Track delivery with Uber</a>}
    </div>
  );
}
