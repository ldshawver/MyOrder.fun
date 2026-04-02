import { useGetCurrentUser, useGetTenantSummary, useGetRecentOrders } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";

export default function Dashboard() {
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  
  if (user?.role === "global_admin") {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight" data-testid="text-dashboard-title">Platform Dashboard</h1>
        <p className="text-muted-foreground" data-testid="text-dashboard-subtitle">Welcome to the OrderFlow global administration center.</p>
        <Link href="/global-admin" className="inline-block text-primary hover:underline font-medium mt-4" data-testid="link-global-admin">
          Enter Global Admin Console &rarr;
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

  if (isLoadingSummary || isLoadingOrders) {
    return <div className="animate-pulse space-y-8">
      <div className="h-8 bg-muted rounded w-64" />
      <div className="grid grid-cols-4 gap-4"><div className="h-32 bg-muted rounded"/><div className="h-32 bg-muted rounded"/><div className="h-32 bg-muted rounded"/><div className="h-32 bg-muted rounded"/></div>
    </div>;
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-end border-b border-border/50 pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-dashboard-title">Overview</h1>
          <p className="text-muted-foreground" data-testid="text-dashboard-subtitle">Performance and activity for {user?.tenantName}.</p>
        </div>
        <Link href="/orders/new" className="bg-primary text-primary-foreground px-4 py-2 rounded-sm text-sm font-medium hover:opacity-90" data-testid="link-new-order">
          New Order
        </Link>
      </div>

      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card className="rounded-sm shadow-sm border-border/50" data-testid="card-metric-revenue">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider">Total Revenue</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-light" data-testid="text-metric-revenue">${summary.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
            </CardContent>
          </Card>
          <Card className="rounded-sm shadow-sm border-border/50" data-testid="card-metric-pending">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider">Pending Orders</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-light" data-testid="text-metric-pending">{summary.pendingOrders}</div>
            </CardContent>
          </Card>
          <Card className="rounded-sm shadow-sm border-border/50" data-testid="card-metric-orders">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider">Total Orders</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-light" data-testid="text-metric-orders">{summary.totalOrders}</div>
            </CardContent>
          </Card>
          <Card className="rounded-sm shadow-sm border-border/50" data-testid="card-metric-customers">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider">Active Customers</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-light" data-testid="text-metric-customers">{summary.totalCustomers}</div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="rounded-sm shadow-sm border-border/50">
          <CardHeader className="border-b border-border/50 bg-muted/20">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Recent Orders</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {recentOrders?.orders?.length ? (
              <div className="divide-y divide-border/50">
                {recentOrders.orders.map(order => (
                  <Link key={order.id} href={`/orders/${order.id}`} className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors block cursor-pointer" data-testid={`row-recent-order-${order.id}`}>
                    <div>
                      <div className="font-medium text-sm">Order #{order.id}</div>
                      <div className="text-xs text-muted-foreground mt-1">{order.customerName} • {order.items.length} items</div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium text-sm">${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                      <div className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-secondary text-secondary-foreground inline-block mt-1">
                        {order.status}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="p-6 text-sm text-muted-foreground text-center">No recent orders found.</div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-sm shadow-sm border-border/50">
          <CardHeader className="border-b border-border/50 bg-muted/20">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Top Products</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {summary?.topProducts?.length ? (
              <div className="divide-y divide-border/50">
                {summary.topProducts.map((product, idx) => (
                  <div key={product.id || idx} className="flex items-center justify-between p-4" data-testid={`row-top-product-${idx}`}>
                    <div className="font-medium text-sm">{product.name}</div>
                    <div className="text-right">
                      <div className="font-medium text-sm">{product.orderCount} orders</div>
                      <div className="text-xs text-muted-foreground font-mono mt-1">${(product.revenue || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} rev</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-sm text-muted-foreground text-center">No top products data.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
