import { useGetCurrentUser, useGetTenantSummary, useGetRecentOrders } from "@workspace/api-client-react";
import { Link } from "wouter";
import { TrendingUp, Clock, Package, Users, ArrowRight, FlaskConical } from "lucide-react";

function MetricCard({ label, value, icon: Icon, color = "primary", link }: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color?: string;
  link?: string;
}) {
  const colorMap: Record<string, { bg: string; text: string; border: string }> = {
    primary: { bg: "bg-primary/10", text: "text-primary", border: "border-primary/20" },
    amber:   { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/20" },
    green:   { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20" },
    purple:  { bg: "bg-violet-500/10", text: "text-violet-400", border: "border-violet-500/20" },
  };
  const c = colorMap[color] || colorMap.primary;

  const inner = (
    <div className="glass-card card-hover-glow rounded-2xl p-5 space-y-4 h-full flex flex-col">
      <div className={`w-10 h-10 rounded-xl ${c.bg} border ${c.border} flex items-center justify-center shrink-0`}>
        <Icon size={18} className={c.text} />
      </div>
      <div className="flex-1">
        <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-widest mb-1">{label}</div>
        <div className="text-3xl font-bold tracking-tight text-foreground">{value}</div>
      </div>
    </div>
  );

  if (link) {
    return <Link href={link} className="block h-full">{inner}</Link>;
  }
  return <div className="h-full">{inner}</div>;
}

function StatusBadge({ status }: { status: string }) {
  const cls = `status-${status.toLowerCase()}` as string;
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${cls} uppercase tracking-wide`}>
      {status}
    </span>
  );
}

export default function Dashboard() {
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });

  if (user?.role === "global_admin") {
    return (
      <div className="space-y-8">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-semibold tracking-widest uppercase mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            Global Administration
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-dashboard-title">
            Platform Dashboard
          </h1>
          <p className="text-muted-foreground" data-testid="text-dashboard-subtitle">
            Welcome to the Alavont Therapeutics global administration center.
          </p>
        </div>
        <Link
          href="/global-admin"
          className="inline-flex items-center gap-2 text-sm font-semibold bg-primary/10 border border-primary/25 text-primary px-5 py-3 rounded-xl hover:bg-primary/20 transition-all"
          data-testid="link-global-admin"
        >
          Enter Global Admin Console
          <ArrowRight size={15} />
        </Link>
      </div>
    );
  }

  const tenantId = user?.tenantId;

  const { data: summary, isLoading: isLoadingSummary } = useGetTenantSummary(
    tenantId || 0,
    { query: { enabled: !!tenantId, queryKey: ["getTenantSummary", tenantId] } }
  );

  const { data: recentOrders, isLoading: isLoadingOrders } = useGetRecentOrders(
    { limit: 5 },
    { query: { enabled: !!tenantId, queryKey: ["getRecentOrders"] } }
  );

  if (!tenantId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-5">
          <FlaskConical size={28} className="text-primary" />
        </div>
        <h2 className="text-xl font-bold mb-2" data-testid="text-dashboard-title">Welcome to Alavont</h2>
        <p className="text-muted-foreground max-w-sm leading-relaxed mb-6" data-testid="text-dashboard-subtitle">
          Your account is pending tenant assignment. Once approved, your dashboard will be fully activated.
        </p>
        <Link
          href="/onboarding"
          className="inline-flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-5 py-3 rounded-xl hover:opacity-90 transition-all"
        >
          Request Tenant Access
          <ArrowRight size={15} />
        </Link>
      </div>
    );
  }

  if (isLoadingSummary || isLoadingOrders) {
    return (
      <div className="animate-pulse space-y-8">
        <div className="h-9 bg-muted/30 rounded-xl w-48" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="h-32 bg-muted/20 rounded-2xl" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-64 bg-muted/20 rounded-2xl" />
          <div className="h-64 bg-muted/20 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-widest mb-1">
            {user?.tenantName}
          </div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-dashboard-title">
            Overview
          </h1>
          <p className="text-muted-foreground text-sm mt-1" data-testid="text-dashboard-subtitle">
            Real-time performance metrics
          </p>
        </div>
        <Link
          href="/orders/new"
          className="shrink-0 inline-flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-5 py-3 rounded-xl hover:opacity-90 transition-all shadow-lg shadow-primary/20"
          data-testid="link-new-order"
        >
          <Package size={15} />
          New Order
        </Link>
      </div>

      {/* Metrics */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            label="Total Revenue"
            value={`$${summary.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
            icon={TrendingUp}
            color="green"
            data-testid="card-metric-revenue"
          />
          <MetricCard
            label="Pending Orders"
            value={summary.pendingOrders}
            icon={Clock}
            color="amber"
            link="/orders"
            data-testid="card-metric-pending"
          />
          <MetricCard
            label="Total Orders"
            value={summary.totalOrders}
            icon={Package}
            color="primary"
            link="/orders"
            data-testid="card-metric-orders"
          />
          <MetricCard
            label="Active Customers"
            value={summary.totalCustomers}
            icon={Users}
            color="purple"
            data-testid="card-metric-customers"
          />
        </div>
      )}

      {/* Recent Orders + Top Products */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Orders */}
        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/40">
            <h2 className="text-sm font-semibold uppercase tracking-wider">Recent Orders</h2>
            <Link href="/orders" className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 font-medium">
              View all <ArrowRight size={12} />
            </Link>
          </div>
          <div className="divide-y divide-border/30">
            {!recentOrders?.orders?.length ? (
              <div className="px-5 py-10 text-sm text-muted-foreground text-center">No recent orders.</div>
            ) : (
              recentOrders.orders.map(order => (
                <Link
                  key={order.id}
                  href={`/orders/${order.id}`}
                  className="flex items-center justify-between px-5 py-3.5 hover:bg-white/[0.02] transition-colors group cursor-pointer block"
                  data-testid={`row-recent-order-${order.id}`}
                >
                  <div>
                    <div className="text-sm font-semibold group-hover:text-primary transition-colors">
                      Order #{order.id}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {order.customerName} · {order.items.length} item{order.items.length !== 1 ? "s" : ""}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold">${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                    <StatusBadge status={order.status} />
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        {/* Top Products */}
        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/40">
            <h2 className="text-sm font-semibold uppercase tracking-wider">Top Products</h2>
            <Link href="/catalog" className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 font-medium">
              Catalog <ArrowRight size={12} />
            </Link>
          </div>
          <div className="divide-y divide-border/30">
            {!summary?.topProducts?.length ? (
              <div className="px-5 py-10 text-sm text-muted-foreground text-center">No products data yet.</div>
            ) : (
              summary.topProducts.map((product, idx) => (
                <div
                  key={product.id || idx}
                  className="flex items-center justify-between px-5 py-3.5"
                  data-testid={`row-top-product-${idx}`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                      {idx + 1}
                    </div>
                    <div className="text-sm font-medium">{product.name}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold">{product.orderCount} orders</div>
                    <div className="text-xs text-muted-foreground">${(product.revenue || 0).toLocaleString(undefined, { minimumFractionDigits: 0 })}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
