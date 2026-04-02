import { useListOrders } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Plus, Package, Clock } from "lucide-react";
import AnimatedHourglass from "@/components/AnimatedHourglass";

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

  const hasPendingOrders = data?.orders?.some(o =>
    o.status === "pending" || o.status === "processing"
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-title">
            Orders
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Track and manage your organization's orders.
          </p>
        </div>
        <Link
          href="/orders/new"
          className="shrink-0 inline-flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-5 py-3 rounded-xl hover:opacity-90 transition-all shadow-lg shadow-primary/20"
          data-testid="link-new-order"
        >
          <Plus size={16} />
          New Order
        </Link>
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-24 gap-6">
          <AnimatedHourglass size={160} message="Loading your orders..." />
        </div>
      ) : data?.orders?.length === 0 ? (
        <div className="glass-card rounded-2xl flex flex-col items-center justify-center py-20 text-center px-6" data-testid="text-empty-state">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
            <Package size={24} className="text-primary" />
          </div>
          <h3 className="font-semibold text-base mb-2">No orders yet</h3>
          <p className="text-sm text-muted-foreground max-w-xs mb-6">
            Place your first order to get started with Alavont Therapeutics.
          </p>
          <Link
            href="/orders/new"
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

          {/* Desktop table */}
          <div className="hidden sm:block glass-card rounded-2xl overflow-hidden">
            <div className="grid grid-cols-[80px_1fr_1fr_120px_100px_100px] gap-0 border-b border-border/40 px-5 py-3">
              {["Order", "Date", "Customer", "Status", "Payment", "Total"].map(h => (
                <div key={h} className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">{h}</div>
              ))}
            </div>
            <div className="divide-y divide-border/30">
              {data?.orders?.map(order => (
                <Link
                  key={order.id}
                  href={`/orders/${order.id}`}
                  className="grid grid-cols-[80px_1fr_1fr_120px_100px_100px] gap-0 px-5 py-4 hover:bg-white/[0.02] transition-colors cursor-pointer group block"
                  data-testid={`row-order-${order.id}`}
                >
                  <div className="text-sm font-semibold font-mono group-hover:text-primary transition-colors" data-testid={`link-order-${order.id}`}>
                    #{order.id}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {new Date(order.createdAt).toLocaleDateString()}
                  </div>
                  <div className="text-sm font-medium truncate pr-4">
                    {order.customerName || "—"}
                  </div>
                  <div>
                    <StatusBadge status={order.status} />
                  </div>
                  <div>
                    <PaymentBadge status={order.paymentStatus} />
                  </div>
                  <div className="text-sm font-semibold font-mono text-right pr-1">
                    ${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Mobile card list */}
          <div className="sm:hidden space-y-3">
            {data?.orders?.map(order => (
              <Link
                key={order.id}
                href={`/orders/${order.id}`}
                className="glass-card card-hover-glow rounded-2xl p-4 block"
                data-testid={`row-order-${order.id}`}
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="text-sm font-bold font-mono text-primary">#{order.id}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {new Date(order.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="text-base font-bold">${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-foreground/80">{order.customerName || "—"}</div>
                  <div className="flex gap-2">
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
