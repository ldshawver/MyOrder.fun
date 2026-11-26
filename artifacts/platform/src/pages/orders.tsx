import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { getGetOrderQueryKey, useGetOrder, useListOrders, useGetCurrentUser, type Order } from "@workspace/api-client-react";
import { Link } from "wouter";
import { canAccessStaffRoute } from "@/lib/routingPolicy";
import { Plus, Package, Clock, ShieldAlert, ShoppingCart } from "lucide-react";
import AnimatedHourglass from "@/components/AnimatedHourglass";
import { CustomerOrderStage } from "@/components/CustomerOrderStage";
import { SupervisorDelayedOrders } from "@/components/SupervisorDelayedOrders";
import { normalizeNotificationRole } from "@/hooks/usePushNotifications";
import { staffFulfillmentAction, staffVisibleFulfillmentState } from "@/lib/staffFulfillmentAction";

const CLOSED_ORDER_STATES = new Set(["completed", "cancelled", "canceled", "refunded", "voided", "archived", "delivered"]);

function StatusBadge({ status }: { status: string }) {
  const cls = `status-${status.toLowerCase()}`;
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${cls} uppercase tracking-wide`}>
      {status}
    </span>
  );
}

function PaymentBadge({ status }: { status: string }) {
  const paid = status === "paid";
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border uppercase tracking-wide ${
      paid
        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
        : "bg-muted/30 text-muted-foreground border-border/50"
    }`}>
      {status}
    </span>
  );
}

export default function Orders() {
  const { getToken } = useAuth();
  const { data, isLoading } = useListOrders(
    { limit: 50 },
    { query: { queryKey: ["listOrders"] } }
  );
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const userRole = normalizeNotificationRole(user?.role);
  const isCustomer = userRole === "user";
  const isSupervisor = userRole === "global_admin" || userRole === "admin";
  const [staffOrders, setStaffOrders] = useState<Array<Order & { fulfillmentStatus?: string | null }>>([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [actioningOrderId, setActioningOrderId] = useState<number | null>(null);

  const refreshStaffOrders = useCallback(async () => {
    if (isCustomer) return;
    setStaffLoading(true);
    try {
      const token = await getToken();
      const response = await fetch("/api/shift-queue/orders", { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 403 ? "You are not authorized to view operational orders." : "Could not load operational orders.");
      const payload = await response.json() as { orders?: Array<Order & { fulfillmentStatus?: string | null }> };
      setStaffOrders(Array.isArray(payload.orders) ? payload.orders : []);
      setStaffError(null);
    } catch (error) {
      setStaffError(error instanceof Error ? error.message : "Could not load operational orders.");
    } finally {
      setStaffLoading(false);
    }
  }, [getToken, isCustomer]);

  useEffect(() => { void refreshStaffOrders(); }, [refreshStaffOrders]);

  // The API enforces tenant and ownership scoping; customers see only their own persisted orders.
  const visibleOrders = useMemo(() => isCustomer ? (data?.orders ?? []) : staffOrders, [data?.orders, isCustomer, staffOrders]);
  const liveOrderId = useMemo(() => {
    const live = visibleOrders.filter(order => !CLOSED_ORDER_STATES.has(order.status.toLowerCase()));
    return live.sort((a, b) => b.id - a.id)[0]?.id ?? 0;
  }, [visibleOrders]);
  const { data: liveOrder, isLoading: isLiveLoading } = useGetOrder(
    liveOrderId,
    { query: { enabled: isCustomer && liveOrderId > 0, queryKey: getGetOrderQueryKey(liveOrderId) } },
  );

  const hasPendingOrders = visibleOrders.some(o =>
    o.status === "pending" || o.status === "processing"
  );

  const advanceOrder = useCallback(async (order: Order & { fulfillmentStatus?: string | null }) => {
    if (order.paymentStatus !== "paid" || actioningOrderId !== null) return;
    const state = staffVisibleFulfillmentState(order.fulfillmentStatus ?? order.status);
    const next = state === "ready" ? "completed" : state === "in_progress" || state === "preparing" || state === "processing" ? "ready" : "in_progress";
    setActioningOrderId(order.id);
    try {
      const token = await getToken();
      const action = staffFulfillmentAction(order.id, next, isSupervisor);
      const response = await fetch(action.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, ...(action.body ? { "Content-Type": "application/json" } : {}) },
        ...(action.body ? { body: JSON.stringify(action.body) } : {}),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error ?? "Order action was not accepted.");
      await refreshStaffOrders();
    } catch (error) {
      setStaffError(error instanceof Error ? error.message : "Order action was not accepted.");
    } finally {
      setActioningOrderId(null);
    }
  }, [actioningOrderId, getToken, isSupervisor, refreshStaffOrders]);

  if (isCustomer) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-title">Order Status</h1>
          <p className="text-muted-foreground text-sm mt-1">The order being prepared right now.</p>
        </div>
        {isLoading || (liveOrderId > 0 && isLiveLoading) ? (
          <div className="flex flex-col items-center justify-center py-24 gap-6">
            <AnimatedHourglass size={160} message="Loading your order..." />
          </div>
        ) : liveOrder ? (
          <CustomerOrderStage order={liveOrder} />
        ) : (
          <div className="glass-card rounded-2xl flex flex-col items-center justify-center py-20 text-center px-6" data-testid="text-empty-state">
            <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
              <ShoppingCart size={24} className="text-primary" />
            </div>
            <h3 className="font-semibold text-base mb-2">No order is being prepared</h3>
            <p className="text-sm text-muted-foreground max-w-xs mb-6">When you place an order, the hourglass and preparation updates show up here.</p>
            <Link href="/cart" className="inline-flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-5 py-2.5 rounded-xl hover:opacity-90 transition-all">
              <ShoppingCart size={15} />
              My Cart
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-title">
            {isCustomer ? "My Orders" : "Orders"}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {isCustomer
              ? "Showing only orders that belong to your signed-in account."
              : "Operational handling has moved to Shift / Queue; this page remains tenant-scoped order history."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canAccessStaffRoute(user?.role) && (
            <Link
              href="/staff/speed-order"
              className="inline-flex items-center rounded-xl border border-border px-5 py-3 text-sm font-semibold hover:bg-muted"
              data-testid="link-speed-order"
            >
              Speed Order
            </Link>
          )}
          <Link
            href="/catalog"
            className="shrink-0 inline-flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-5 py-3 rounded-xl hover:opacity-90 transition-all shadow-lg shadow-primary/20"
            data-testid="link-new-order"
          >
            <Plus size={16} />
            Catalogue
          </Link>
          </div>
      </div>

      {isSupervisor && <SupervisorDelayedOrders />}

      {staffError && <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">{staffError}</div>}
      {isLoading || staffLoading ? (
        <div className="flex flex-col items-center justify-center py-24 gap-6">
          <AnimatedHourglass size={160} message="Loading your orders..." />
        </div>
      ) : visibleOrders.length === 0 ? (
        <div className="glass-card rounded-2xl flex flex-col items-center justify-center py-20 text-center px-6" data-testid="text-empty-state">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
            {isCustomer ? <ShieldAlert size={24} className="text-primary" /> : <Package size={24} className="text-primary" />}
          </div>
          <h3 className="font-semibold text-base mb-2">
            {isCustomer ? "No orders yet" : "No orders yet"}
          </h3>
          <p className="text-sm text-muted-foreground max-w-xs mb-6">
            {isCustomer
              ? "Orders placed from your signed-in account will appear here."
              : "Place your first order to get started."}
          </p>
          <Link
            href="/catalog"
            className="inline-flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-5 py-2.5 rounded-xl hover:opacity-90 transition-all"
          >
            <Plus size={15} />
            Place First Order
          </Link>
        </div>
      ) : (
        <>
          {/* Pending orders banner with hourglass */}
          {hasPendingOrders && (
            <div className="glass-card rounded-2xl p-5 border border-primary/20 bg-primary/5">
              <div className="flex items-start gap-4">
                <Clock size={18} className="text-primary mt-0.5 shrink-0" />
                <div>
                  <div className="text-sm font-semibold text-primary mb-0.5">Orders In Progress</div>
                  <div className="text-xs text-muted-foreground">
                    You have orders being processed. You'll receive a notification when they're ready.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Compact fulfillment cards: one column on phones, two on tablets, three on wide CSR screens. */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3" data-testid="orders-card-grid">
            {visibleOrders.map(order => {
              const lifecycle = staffVisibleFulfillmentState((order as Order & { fulfillmentStatus?: string | null }).fulfillmentStatus ?? order.status);
              const actionLabel = lifecycle === "ready" ? "Complete" : lifecycle === "in_progress" || lifecycle === "preparing" || lifecycle === "processing" ? "Mark ready" : "Claim";
              return (
              <div
                key={order.id}
                className="glass-card card-hover-glow rounded-2xl p-4 min-w-0 group"
                data-testid={`row-order-${order.id}`}
              >
                <Link href={`/orders/${order.id}`} className="block">
                  <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="text-sm font-bold font-mono text-primary group-hover:underline" data-testid={`link-order-${order.id}`}>#{order.id}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {new Date(order.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="text-base font-bold font-mono">${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                </div>
                <div className="flex items-end justify-between gap-3">
                  <div className="text-sm font-medium text-foreground/80 truncate min-w-0">{order.customerName || "—"}</div>
                  <div className="flex flex-wrap justify-end gap-2 shrink-0">
                    <StatusBadge status={order.status} />
                    <PaymentBadge status={order.paymentStatus} />
                  </div>
                </div>
                </Link>
                {order.paymentStatus === "paid" ? (
                  <button type="button" className="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60" disabled={actioningOrderId !== null} onClick={() => void advanceOrder(order as Order & { fulfillmentStatus?: string | null })} data-testid={`button-order-action-${order.id}`}>
                    {actioningOrderId === order.id ? "Updating…" : actionLabel}
                  </button>
                ) : (
                  <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-testid={`payment-pending-${order.id}`}>Awaiting verified payment — not available for fulfillment.</p>
                )}
              </div>
            )})}
          </div>
        </>
      )}
    </div>
  );
}
