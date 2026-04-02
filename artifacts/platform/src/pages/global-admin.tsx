import { useGetAdminStats, useListOnboardingRequests } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "wouter";

export default function GlobalAdmin() {
  const { data: stats, isLoading: isStatsLoading } = useGetAdminStats({ query: { queryKey: ["getAdminStats"] } });
  const { data: requests, isLoading: isReqLoading } = useListOnboardingRequests(
    { status: "submitted", limit: 5 },
    { query: { queryKey: ["listOnboardingRequests", "submitted"] } }
  );

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">Global Administrator</h1>
        <p className="text-muted-foreground" data-testid="text-subtitle">Platform oversight and tenant management.</p>
      </div>

      {isStatsLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-6 animate-pulse">
          {[...Array(5)].map((_, i) => <div key={i} className="h-28 bg-muted/50 rounded-sm" />)}
        </div>
      ) : stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-6">
          <Card className="rounded-sm border-border/50 shadow-sm" data-testid="card-metric-tenants">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider">Total Tenants</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-light">{stats.totalTenants}</div>
            </CardContent>
          </Card>
          <Card className="rounded-sm border-border/50 shadow-sm" data-testid="card-metric-active-tenants">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider">Active Tenants</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-light">{stats.activeTenants}</div>
            </CardContent>
          </Card>
          <Card className="rounded-sm border-border/50 shadow-sm bg-primary/5 border-primary/20" data-testid="card-metric-pending-apps">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono font-medium text-primary uppercase tracking-wider">Pending Apps</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-light text-primary">{stats.pendingOnboardingRequests}</div>
            </CardContent>
          </Card>
          <Card className="rounded-sm border-border/50 shadow-sm" data-testid="card-metric-gmv">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider">Total GMV</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-light">${stats.totalRevenue.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card className="rounded-sm border-border/50 shadow-sm" data-testid="card-metric-platform-orders">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider">Platform Orders</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-light">{stats.totalOrders.toLocaleString()}</div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="rounded-sm border-border/50 shadow-sm flex flex-col">
          <CardHeader className="bg-muted/10 border-b border-border/50 pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Pending Applications</CardTitle>
            <Link href="/global-admin/onboarding" className="text-xs font-mono uppercase tracking-widest text-primary hover:underline" data-testid="link-view-all-onboarding">View All &rarr;</Link>
          </CardHeader>
          <CardContent className="p-0 flex-1">
            {isReqLoading ? (
              <div className="text-center py-12 text-muted-foreground font-mono text-xs uppercase tracking-widest animate-pulse">Loading...</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-border/30">
                    <TableHead className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Company</TableHead>
                    <TableHead className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Contact</TableHead>
                    <TableHead className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests?.requests?.map(req => (
                    <TableRow key={req.id} className="border-border/30">
                      <TableCell className="font-medium text-sm">{req.companyName}</TableCell>
                      <TableCell className="text-sm">{req.contactName}</TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">{new Date(req.createdAt).toLocaleDateString()}</TableCell>
                    </TableRow>
                  ))}
                  {(!requests?.requests || requests.requests.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center py-12 text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">No pending applications</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-sm border-border/50 shadow-sm flex flex-col">
          <CardHeader className="bg-muted/10 border-b border-border/50 pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Recent Activity</CardTitle>
            <Link href="/global-admin/audit" className="text-xs font-mono uppercase tracking-widest text-primary hover:underline" data-testid="link-view-all-audit">View Log &rarr;</Link>
          </CardHeader>
          <CardContent className="p-0 flex-1 overflow-y-auto max-h-[400px]">
            <div className="divide-y divide-border/30">
              {stats?.recentActivity?.map(log => (
                <div key={log.id} className="flex justify-between items-start p-4 hover:bg-muted/5 transition-colors">
                  <div>
                    <div className="font-medium text-sm mb-1">{log.action}</div>
                    <div className="text-xs text-muted-foreground font-mono">{log.actorEmail} • {log.resourceType}</div>
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest text-right">
                    {new Date(log.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
              {(!stats?.recentActivity || stats.recentActivity.length === 0) && (
                <div className="text-center py-12 text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed border-b-0">
                  No recent activity
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
