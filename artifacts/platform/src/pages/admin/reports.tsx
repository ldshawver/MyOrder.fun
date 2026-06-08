import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BarChart3, Printer, Loader2 } from "lucide-react";

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
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [csrId, setCsrId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("all");
  const [product, setProduct] = useState("");
  const [reprinting, setReprinting] = useState<number | null>(null);
  const [reprintMsg, setReprintMsg] = useState<{ id: number; ok: boolean; text: string } | null>(null);
  const [printingReport, setPrintingReport] = useState(false);
  const [printReportMsg, setPrintReportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (csrId) params.set("csrId", csrId);
    if (paymentMethod !== "all") params.set("paymentMethod", paymentMethod);
    if (product.trim()) params.set("product", product.trim());
    const q = params.toString();
    return q ? `?${q}` : "";
  }, [csrId, dateFrom, dateTo, paymentMethod, product]);

  const load = useCallback(async () => {
    setLoading(true);
    const token = await getToken();
    const res = await fetch(`/api/admin/reports/summary${buildQuery()}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Failed to load reports");
    setData(body);
    setLoading(false);
  }, [buildQuery, getToken]);

  async function reprintReceipt(orderId: number) {
    setReprinting(orderId);
    setReprintMsg(null);
    try {
      const token = await getToken();
      const r = await fetch(`/api/print/orders/${orderId}/receipt`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; printerName?: string };
      setReprintMsg({ id: orderId, ok: d.ok !== false && r.ok, text: d.ok !== false && r.ok ? `Sent to ${d.printerName ?? "printer"}` : (d.error ?? `Failed (${r.status})`) });
    } catch (e) {
      setReprintMsg({ id: orderId, ok: false, text: e instanceof Error ? e.message : "Print failed" });
    } finally {
      setReprinting(null);
    }
  }

  async function printReport() {
    if (!data) { window.print(); return; }
    setPrintingReport(true);
    setPrintReportMsg(null);
    try {
      const token = await getToken();
      const t = data.totals;
      const rows = [
        { label: "Orders", value: String(t.orderCount) },
        { label: "Revenue", value: `$${Number(t.revenue || 0).toFixed(2)}` },
        { label: "Avg Order", value: `$${Number(t.averageOrderValue || 0).toFixed(2)}` },
        { label: "Discrepancy", value: `$${Number(t.discrepancyTotal || 0).toFixed(2)}` },
        { label: "Active Shifts", value: String(t.activeShiftCount) },
      ];
      const dateLabel = dateFrom || dateTo ? `${dateFrom || "…"} – ${dateTo || "…"}` : "All time";
      const r = await fetch("/api/print/report", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: `Sales Report — ${dateLabel}`, rows }),
      });
      const d = await r.json().catch(() => ({})) as { ok?: boolean; noprinter?: boolean; printerName?: string };
      if (d.noprinter) {
        window.print();
        setPrintReportMsg({ ok: true, text: "Sent to browser print (no printer configured)" });
      } else if (d.ok) {
        setPrintReportMsg({ ok: true, text: `Sent to ${d.printerName ?? "printer"}` });
      } else {
        window.print();
        setPrintReportMsg({ ok: false, text: "Server print failed — browser print opened" });
      }
    } catch {
      window.print();
      setPrintReportMsg({ ok: false, text: "Server unreachable — browser print opened" });
    } finally {
      setPrintingReport(false);
    }
  }

  async function exportCsv() {
    const token = await getToken();
    const res = await fetch(`/api/admin/reports/export.csv${buildQuery()}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error("Failed to export CSV");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "myorder-reports.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => { load().catch(err => { setError(err.message); setLoading(false); }); }, [load]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="border-b border-border/50 pb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">Sales, payment, product, workforce, discrepancy, and receipt reprint reporting.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => exportCsv().catch(err => setError(err.message))} className="rounded-sm">Export CSV</Button>
          <Button variant="outline" onClick={() => load().catch(err => setError(err.message))} className="rounded-sm">Refresh</Button>
          <div className="flex flex-col items-end gap-1">
            <Button variant="outline" onClick={printReport} disabled={printingReport} className="rounded-sm gap-1.5">
              {printingReport ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
              {printingReport ? "Printing…" : "Print Report"}
            </Button>
            {printReportMsg && (
              <span className={`text-[10px] ${printReportMsg.ok ? "text-emerald-400" : "text-amber-400"}`}>{printReportMsg.text}</span>
            )}
          </div>
        </div>
      </div>

      <Card className="rounded-sm border-border/50">
        <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">From</div>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-sm" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">To</div>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-sm" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">CSR ID</div>
            <Input inputMode="numeric" value={csrId} onChange={(e) => setCsrId(e.target.value.replace(/[^\d]/g, ""))} placeholder="All CSRs" className="rounded-sm" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Payment</div>
            <select className="h-9 w-full rounded-sm bg-background border border-input px-3 text-sm" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              <option value="all">All methods</option>
              <option value="cash">Cash</option>
              <option value="stripe">Stripe</option>
              <option value="card">Card</option>
              <option value="venmo">Venmo</option>
              <option value="cash_app">Cash App</option>
              <option value="credit">Credit</option>
            </select>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Product</div>
            <Input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Name contains" className="rounded-sm" />
          </div>
          <Button onClick={() => load().catch(err => setError(err.message))} className="rounded-sm">Apply Filters</Button>
        </CardContent>
      </Card>

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
                  <div className="flex flex-col items-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-sm gap-1"
                      onClick={() => reprintReceipt(receipt.orderId)}
                      disabled={reprinting === receipt.orderId}
                    >
                      {reprinting === receipt.orderId
                        ? <Loader2 size={11} className="animate-spin" />
                        : <Printer size={11} />}
                      {reprinting === receipt.orderId ? "Printing…" : "Print"}
                    </Button>
                    {reprintMsg?.id === receipt.orderId && (
                      <span className={`text-[10px] ${reprintMsg.ok ? "text-emerald-400" : "text-destructive"}`}>
                        {reprintMsg.text}
                      </span>
                    )}
                  </div>
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
