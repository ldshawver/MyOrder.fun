import { useMemo } from "react";
import { getGetOrderQueryKey, useGetOrder, useListOrders, useGetCurrentUser } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Plus, Package, Clock, ShieldAlert, ShoppingCart } from "lucide-react";
import AnimatedHourglass from "@/components/AnimatedHourglass";
import { CustomerOrderStage } from "@/components/CustomerOrderStage";
import { SupervisorDelayedOrders } from "@/components/SupervisorDelayedOrders";
import { normalizeNotificationRole } from "@/hooks/usePushNotifications";

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
  const { data, isLoading } = useListOrders(
    { limit: 50 },
    { query: { queryKey: ["listOrders"] } }
  );
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const userRole = normalizeNotificationRole(user?.role);
  const isCustomer = userRole === "user";
  const isSupervisor = userRole === "global_admin" || userRole === "admin";

  // The API enforces tenant and ownership scoping; customers see only their own persisted orders.
  const visibleOrders = useMemo(() => data?.orders ?? [], [data?.orders]);
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
        <Link
          href="/catalog"
          className="shrink-0 inline-flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-5 py-3 rounded-xl hover:opacity-90 transition-all shadow-lg shadow-primary/20"
          data-testid="link-new-order"
        >
          <Plus size={16} />
          Catalogue
        </Link>
      </div>

      {isSupervisor && <SupervisorDelayedOrders />}

      {isLoading ? (
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
            {visibleOrders.map(order => (
              <Link
                key={order.id}
                href={`/orders/${order.id}`}
                className="glass-card card-hover-glow rounded-2xl p-4 block min-w-0 group"
                data-testid={`row-order-${order.id}`}
              >
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
            ))}
          </div>
        </>
      )}
    </div>
  );
}
