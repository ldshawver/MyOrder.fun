import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { getGetOrderQueryKey, useGetOrder, useListOrders, useGetCurrentUser, type Order } from "@workspace/api-client-react";
import { Link } from "wouter";
import { canAccessStaffRoute } from "@/lib/routingPolicy";
import { Plus, Package, Clock, ShieldAlert, ShoppingCart } from "lucide-react";
import AnimatedHourglass from "@/components/AnimatedHourglass";
import { CustomerOrderStage } from "@/components/CustomerOrderStage";
import { SupervisorDelayedOrders } from "@/components/SupervisorDelayedOrders";
import { normalizeNotificationRole } from "@/hooks/usePushNotifications";
import { OrderCourier } from "@/components/OrderCourier";
import { staffFulfillmentAction, staffVisibleFulfillmentState } from "@/lib/staffFulfillmentAction";

type StaffGroup = { id: number; provider: string; method: string; status: string };
type StaffOrder = Order & { fulfillmentStatus?: string | null; fulfillmentGroups?: StaffGroup[]; acceptedAt?: string | null };
const canPrepare = (order: StaffOrder) => order.paymentStatus === "paid" ||
  (order.paymentStatus === "unpaid" && (order.selectedPaymentMethod ?? order.paymentMethod) === "cash");

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
  const queryClient = useQueryClient();
  const { data, isLoading } = useListOrders(
    { limit: 50 },
    { query: { queryKey: ["listOrders"] } }
  );
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const userRole = normalizeNotificationRole(user?.role);
  const isCustomer = userRole === "user";
  const isSupervisor = userRole === "global_admin" || userRole === "admin";
  const [staffOrders, setStaffOrders] = useState<StaffOrder[]>([]);
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
      const payload = await response.json() as { orders?: StaffOrder[] };
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

  const advanceOrder = useCallback(async (order: StaffOrder, group?: StaffGroup, completeDelivery = false) => {
    if (!canPrepare(order) || actioningOrderId !== null) return;
    const state = staffVisibleFulfillmentState(group?.status ?? order.fulfillmentStatus ?? order.status);
    const next = state === "ready" ? "completed" : state === "in_progress" || state === "processing" ? "ready" : "in_progress";
    const uber = (group?.method ?? order.deliveryMethod) === "uber_direct";
    setActioningOrderId(order.id);
    setStaffError(null);
    try {
      const token = await getToken();
      const send = async (endpoint: string, body?: Record<string, string>, method = "POST") => {
        const response = await fetch(endpoint, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
          const result = await response.json().catch(() => null) as { error?: string; state?: string } | null;
          throw new Error(result?.error ?? result?.state?.replaceAll("_", " ") ?? "Order action was not accepted.");
        }
      };
      if (group && (completeDelivery || !uber || state !== "ready")) {
        if (next === "in_progress" && !order.acceptedAt) await send(`/api/orders/${order.id}/claim`, {});
        await send(`/api/orders/${order.id}/fulfillment-groups/${group.id}/status`, { status: next }, "PATCH");
      } else if (!group && (completeDelivery || !uber || state !== "ready")) {
        const action = next === "in_progress"
          ? { endpoint: `/api/orders/${order.id}/claim`, body: {} }
          : staffFulfillmentAction(order.id, next, isSupervisor);
        await send(action.endpoint, action.body);
      }
      if (!completeDelivery && uber && (next === "ready" || state === "ready") && order.paymentStatus === "paid") {
        await send(`/api/orders/${order.id}/courier/request`, {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Order action was not accepted.";
      await refreshStaffOrders();
      setStaffError(message);
      return;
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["order-courier", order.id] });
      setActioningOrderId(null);
    }
    await refreshStaffOrders();
  }, [actioningOrderId, getToken, isSupervisor, queryClient, refreshStaffOrders]);

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
              const uber = order.deliveryMethod === "uber_direct";
              const preparing = lifecycle === "in_progress" || lifecycle === "processing";
              const groups = (order as StaffOrder).fulfillmentGroups ?? [];
              const uberGroup = groups.find(group => group.method === "uber_direct");
              const cashDue = order.paymentStatus === "unpaid" && (order.selectedPaymentMethod ?? order.paymentMethod) === "cash";
              const actionLabel = lifecycle === "ready" ? "Complete" : preparing
                ? uber ? (cashDue ? "Mark ready for delivery" : "Ready & request Uber")
                  : order.deliveryMethod === "csr_delivery" ? "Ready for delivery" : "Ready for pickup"
                : "Claim & start";
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
                {uber && order.deliveryFee != null && <p className="mt-2 text-xs text-muted-foreground">Uber fee in order total: ${order.deliveryFee.toFixed(2)}</p>}
                {uber && <OrderCourier orderId={order.id} busy={actioningOrderId !== null} request={
                  (uberGroup?.status ?? lifecycle) === "ready" && order.paymentStatus === "paid"
                    ? () => void advanceOrder(order, uberGroup) : undefined
                } complete={(uberGroup?.status ?? lifecycle) === "ready" && order.paymentStatus === "paid"
                  ? () => void advanceOrder(order, uberGroup, true) : undefined} />}
                {cashDue && (
                  <Link className="mt-3 block text-xs font-semibold text-primary underline" href={`/orders/${order.id}?cashCloseout=1`}>Close out cash</Link>
                )}
                {groups.length > 0 && canPrepare(order) && groups.filter(group => group.provider !== "cj").map(group => {
                  const stage = staffVisibleFulfillmentState(group.status);
                  if (!["submitted", "in_progress", "ready"].includes(stage ?? "") ||
                      (stage === "ready" && (cashDue || group.method === "uber_direct"))) return null;
                  const label = stage === "submitted" ? "Claim & start" : stage === "ready" ? "Complete"
                    : group.method === "pickup" ? "Ready for pickup"
                    : group.method === "uber_direct" && !cashDue ? "Ready & request Uber" : "Ready for delivery";
                  return <button key={group.id} type="button" className="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                    disabled={actioningOrderId !== null} onClick={() => void advanceOrder(order, group)}>{label}{groups.length > 1 ? ` · ${group.provider}` : ""}</button>;
                })}
                {groups.length === 0 && canPrepare(order) && (lifecycle !== "ready" || (!uber && !cashDue)) ? (
                  <button type="button" className="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60" disabled={actioningOrderId !== null} onClick={() => void advanceOrder(order as Order & { fulfillmentStatus?: string | null })} data-testid={`button-order-action-${order.id}`}>
                    {actioningOrderId === order.id ? "Updating…" : actionLabel}
                  </button>
                ) : !canPrepare(order) ? (
                  <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-testid={`payment-pending-${order.id}`}>Awaiting verified payment — not available for fulfillment.</p>
                ) : null}
              </div>
            )})}
          </div>
        </>
      )}
    </div>
  );
}
