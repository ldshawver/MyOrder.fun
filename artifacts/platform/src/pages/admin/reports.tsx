import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Printer } from "lucide-react";

type ReportsSummary = {
  totals: {
    orderCount: number;
    paidOrderCount: number;
    revenue: number;
    averageOrderValue: number;
    activeShiftCount: number;
    discrepancyTotal: number;
  };
  salesTrend: Array<{ date: string; orders: number; revenue: number }>;
  paymentTrend: Array<{ method: string; orders: number; revenue: number }>;
  productPerformance: Array<{ name: string; quantity: number; revenue: number }>;
  workforce: Array<{ shiftId: number; name: string; status: string; revenue: number; orderCount: number; differenceAmount: number; depositAmount: number }>;
  receipts: Array<{ orderId: number; createdAt: string; total: number; paymentStatus: string; paymentMethod?: string | null }>;
};

function money(value: number) {
  return `$${Number(value || 0).toFixed(2)}`;
}

export default function AdminReports() {
  const { getToken } = useAuth();
  const [data, setData] = useState<ReportsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const token = await getToken();
    const res = await fetch("/api/admin/reports/summary", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Failed to load reports");
    setData(body);
    setLoading(false);
  }, [getToken]);

  useEffect(() => { load().catch(err => { setError(err.message); setLoading(false); }); }, [load]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="border-b border-border/50 pb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">Sales, payment, product, workforce, discrepancy, and receipt reprint reporting.</p>
        </div>
        <Button variant="outline" onClick={() => load().catch(err => setError(err.message))} className="rounded-sm">Refresh</Button>
      </div>

      {loading ? <div className="text-sm text-muted-foreground animate-pulse">Loading reports...</div> : error ? (
        <div className="text-sm text-destructive">{error}</div>
      ) : data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            {[
              ["Orders", data.totals.orderCount],
              ["Paid", data.totals.paidOrderCount],
              ["Revenue", money(data.totals.revenue)],
              ["AOV", money(data.totals.averageOrderValue)],
              ["Active Shifts", data.totals.activeShiftCount],
              ["Discrepancy", money(data.totals.discrepancyTotal)],
            ].map(([label, value]) => (
              <Card key={label} className="rounded-sm border-border/50">
                <CardContent className="pt-4">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
                  <div className="text-xl font-bold mt-1">{value}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ReportList title="Sales Trend" icon={<BarChart3 size={16} />} rows={data.salesTrend.map(row => [row.date, `${row.orders} orders`, money(row.revenue)])} />
            <ReportList title="Payment Trends" rows={data.paymentTrend.map(row => [row.method, `${row.orders} orders`, money(row.revenue)])} />
            <ReportList title="Product Performance" rows={data.productPerformance.map(row => [row.name, `${row.quantity} sold`, money(row.revenue)])} />
            <ReportList title="Workforce" rows={data.workforce.map(row => [`Shift #${row.shiftId} · ${row.name}`, `${row.orderCount} orders · ${row.status}`, `Deposit ${money(row.depositAmount)}`])} />
          </div>

          <Card className="rounded-sm border-border/50">
            <CardHeader className="bg-muted/10 border-b border-border/50 flex flex-row items-center gap-2">
              <Printer size={16} />
              <CardTitle className="text-sm uppercase tracking-wider">Receipt Reprints</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 divide-y divide-border/40">
              {data.receipts.map(receipt => (
                <div key={receipt.orderId} className="py-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">Order #{receipt.orderId}</div>
                    <div className="text-xs text-muted-foreground">{new Date(receipt.createdAt).toLocaleString()} · {receipt.paymentStatus} · {receipt.paymentMethod ?? "cash"}</div>
                  </div>
                  <Button asChild size="sm" variant="outline" className="rounded-sm">
                    <a href={`/api/print/orders/${receipt.orderId}/receipt`} target="_blank" rel="noreferrer">Reprint</a>
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ReportList({ title, rows, icon }: { title: string; rows: string[][]; icon?: ReactNode }) {
  return (
    <Card className="rounded-sm border-border/50">
      <CardHeader className="bg-muted/10 border-b border-border/50 flex flex-row items-center gap-2">
        {icon}
        <CardTitle className="text-sm uppercase tracking-wider">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-3 divide-y divide-border/40">
        {rows.length === 0 ? <div className="text-sm text-muted-foreground py-6">No data yet.</div> : rows.map((row, index) => (
          <div key={`${row[0]}-${index}`} className="py-2.5 grid grid-cols-3 gap-3 text-sm">
            <div className="font-medium truncate">{row[0]}</div>
            <div className="text-muted-foreground truncate">{row[1]}</div>
            <div className="font-mono text-right">{row[2]}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
