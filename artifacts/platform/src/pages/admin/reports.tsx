import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type SalesRow = { date: string; orders: number; revenue: number };

type ReportsSummary = {
  totals: { orderCount: number; paidOrderCount: number; revenue: number; averageOrderValue: number; activeShiftCount: number; discrepancyTotal: number };
  salesTrend: SalesRow[];
  salesByCsr: Array<{ id: number | null; name: string; orders: number; revenue: number }>;
  hourOfDay: Array<{ hour: number; label: string; orders: number; revenue: number }>;
  weekdayTrend: Array<{ day: string; orders: number; revenue: number }>;
  paymentTrend: Array<{ method: string; orders: number; revenue: number }>;
  productPerformance: Array<{ name: string; quantity: number; revenue: number }>;
  inventory: Array<{ name: string; onHand: string; available: string; locations: number }>;
  inventoryLocations: Array<{ product: string; location: string; onHand: string; available: string; par: string }>;
  suggestedOrder: Array<{ product: string; location: string; available: string; par: string; reorderPoint: string; transfer: string; orderQuantity: string }>;
  csrOptions: Array<{ id: number; name: string }>;
  workforce: Array<{ shiftId: number; name: string; status: string; revenue: number; orderCount: number; differenceAmount: number; depositAmount: number }>;
  receipts: Array<{ orderId: number; createdAt: string; total: number; paymentStatus: string; paymentMethod?: string | null }>;
};

const REPORTS = [
  { id: "sales", label: "Sales trends" },
  { id: "time", label: "Time of day" },
  { id: "inventory", label: "Inventory" },
  { id: "suggested", label: "Suggested order" },
  { id: "payments", label: "Payments" },
  { id: "workforce", label: "Workforce" },
  { id: "receipts", label: "Receipt reprints" },
] as const;
type ReportId = (typeof REPORTS)[number]["id"];
type SalesView = "time" | "product" | "csr";

const tooltipStyle = { background: "#111827", border: "1px solid #374151", borderRadius: 4, fontSize: 12, color: "#e5e7eb" };
const tick = { fill: "#94a3b8", fontSize: 11 };

function money(value: number) {
  return `$${Number(value || 0).toFixed(2)}`;
}
function qty(value: string | number) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(value);
}
function peak<T extends { orders: number }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>((best, row) => (!best || row.orders > best.orders ? row : best), undefined);
}

export default function AdminReports() {
  const { getToken } = useAuth();
  const [data, setData] = useState<ReportsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<ReportId>("sales");
  const [salesView, setSalesView] = useState<SalesView>("time");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [csrId, setCsrId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("all");
  const [product, setProduct] = useState("");

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
    setError(null);
    const token = await getToken();
    const res = await fetch(`/api/admin/reports/summary${buildQuery()}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "Failed to load reports");
    setData(body);
    setLoading(false);
  }, [buildQuery, getToken]);

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

  const title = REPORTS.find((item) => item.id === report)?.label ?? "Report";
  const range = [dateFrom, dateTo].filter(Boolean).join(" to ") || "Latest orders";

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <style>{`@media print {
        body * { visibility: hidden; }
        #report-sheet, #report-sheet * { visibility: visible; color: #111 !important; }
        #report-sheet { position: absolute; left: 0; top: 0; width: 100%; background: white !important; }
        #report-sheet svg * { color: inherit !important; }
      }`}</style>
      <div className="border-b border-border/50 pb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">Pick a report, review the chart, then print that report.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Report</span>
            <select aria-label="Report" className="h-10 min-w-52 rounded-sm bg-background border border-input px-3 text-sm" value={report} onChange={(event) => setReport(event.target.value as ReportId)}>
              {REPORTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          {report === "sales" && (
            <label className="text-xs">
              <span className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Show</span>
              <select aria-label="Sales breakdown" className="h-10 rounded-sm bg-background border border-input px-3 text-sm" value={salesView} onChange={(event) => setSalesView(event.target.value as SalesView)}>
                <option value="time">Time period</option>
                <option value="product">Product</option>
                <option value="csr">CSR</option>
              </select>
            </label>
          )}
          <Button onClick={() => window.print()} className="rounded-sm">Print</Button>
          <Button variant="outline" onClick={() => exportCsv().catch(err => setError(err.message))} className="rounded-sm">Export CSV</Button>
          <Button variant="outline" onClick={() => load().catch(err => setError(err.message))} className="rounded-sm">Refresh</Button>
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
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">CSR</div>
            <select aria-label="CSR" className="h-9 w-full rounded-sm bg-background border border-input px-3 text-sm" value={csrId} onChange={(e) => setCsrId(e.target.value)}>
              <option value="">All CSRs</option>
              {(data?.csrOptions ?? []).map((csr) => <option key={csr.id} value={csr.id}>{csr.name}</option>)}
            </select>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Payment</div>
            <select aria-label="Payment method" className="h-9 w-full rounded-sm bg-background border border-input px-3 text-sm" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              <option value="all">All methods</option>
              <option value="cash">Cash</option>
              <option value="paypal">PayPal wallet</option>
              <option value="paypal_card">PayPal-processed card</option>
              <option value="customer_credit">Customer Credit</option>
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
        <div id="report-sheet" className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold">{title}{report === "sales" ? ` · ${salesView === "time" ? "time period" : salesView === "product" ? "product" : "CSR"}` : ""}</h2>
            <p className="text-xs text-muted-foreground">{range}. Sales times are Pacific. Inventory and suggested order use current stock. Sales use the latest 500 orders.</p>
          </div>
          <ReportView report={report} salesView={salesView} data={data} />
        </div>
      )}
    </div>
  );
}

function Numbers({ items }: { items: Array<[string, string | number]> }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {items.map(([label, value]) => (
        <Card key={label} className="rounded-sm border-border/50">
          <CardContent className="pt-4">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
            <div className="text-xl font-bold mt-1">{value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ChartBox({ children, height = "h-72" }: { children: ReactNode; height?: string }) {
  return <Card className="rounded-sm border-border/50"><CardContent className={`pt-4 ${height} w-full`}>{children}</CardContent></Card>;
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <Card className="rounded-sm border-border/50">
      <CardContent className="pt-2 overflow-x-auto">
        {rows.length === 0 ? <div className="text-sm text-muted-foreground py-6">No rows for this report.</div> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">{headers.map((header) => <th key={header} className="py-2 pr-3 font-medium">{header}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row[0]}-${index}`} className="border-t border-border/40">
                  {row.map((cell, cellIndex) => <td key={cellIndex} className={`py-2 pr-3 ${cellIndex === 0 ? "font-medium" : "font-mono"}`}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function ReportView({ report, salesView, data }: { report: ReportId; salesView: SalesView; data: ReportsSummary }) {
  if (report === "sales") return <SalesReport view={salesView} data={data} />;
  if (report === "time") {
    const busyHour = peak(data.hourOfDay);
    const busyDay = peak(data.weekdayTrend);
    return (
      <div className="space-y-4">
        <Numbers items={[["Orders", data.totals.orderCount], ["Paid revenue", money(data.totals.revenue)], ["Busiest hour", busyHour ? `${busyHour.label} · ${busyHour.orders}` : "—"], ["Busiest day", busyDay ? `${busyDay.day} · ${busyDay.orders}` : "—"]]} />
        <ChartBox>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.hourOfDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="label" tick={tick} interval={1} />
              <YAxis allowDecimals={false} tick={tick} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="orders" fill="#2dd4bf" name="Orders" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
        <ChartBox height="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.weekdayTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="day" tick={tick} />
              <YAxis allowDecimals={false} tick={tick} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="orders" fill="#fbbf24" name="Orders" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
      </div>
    );
  }
  if (report === "inventory") {
    const short = data.inventoryLocations.filter((row) => Number(row.par) > 0 && Number(row.available) < Number(row.par)).length;
    const chart = data.inventory.slice(0, 12).map((row) => ({ name: row.name.slice(0, 28), available: Number(row.available) }));
    return (
      <div className="space-y-4">
        <Numbers items={[["Products", data.inventory.length], ["Below par", short], ["Top available", chart[0] ? qty(chart[0].available) : "0"], ["Locations listed", data.inventoryLocations.length]]} />
        <ChartBox height="h-96">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis type="number" tick={tick} />
              <YAxis type="category" dataKey="name" width={140} tick={tick} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="available" fill="#2dd4bf" name="Available" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
        <Table headers={["Product", "Location", "On hand", "Available", "Par"]} rows={data.inventoryLocations.slice(0, 200).map((row) => [row.product, row.location, qty(row.onHand), qty(row.available), qty(row.par)])} />
      </div>
    );
  }
  if (report === "suggested") {
    const toBuy = data.suggestedOrder.reduce((sum, row) => sum + Number(row.orderQuantity || 0), 0);
    const chart = data.suggestedOrder.slice(0, 12).map((row) => ({ name: `${row.product} · ${row.location}`.slice(0, 32), order: Number(row.orderQuantity) }));
    return (
      <div className="space-y-4">
        <Numbers items={[["Lines to act on", data.suggestedOrder.length], ["Units to buy", qty(toBuy)], ["Can transfer", data.suggestedOrder.filter((row) => row.transfer).length], ["Products tracked", data.inventory.length]]} />
        <ChartBox height="h-96">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis type="number" tick={tick} />
              <YAxis type="category" dataKey="name" width={160} tick={tick} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="order" fill="#fbbf24" name="Order" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
        <Table headers={["Product", "Location", "Available", "Reorder at", "Transfer", "Buy"]} rows={data.suggestedOrder.map((row) => [row.product, row.location, qty(row.available), qty(row.reorderPoint), row.transfer || "—", qty(row.orderQuantity)])} />
      </div>
    );
  }
  if (report === "payments") {
    return (
      <div className="space-y-4">
        <Numbers items={[["Paid orders", data.totals.paidOrderCount], ["Revenue", money(data.totals.revenue)], ["Average order", money(data.totals.averageOrderValue)], ["Methods", data.paymentTrend.length]]} />
        <ChartBox>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.paymentTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="method" tick={tick} />
              <YAxis tick={tick} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="revenue" fill="#2dd4bf" name="Revenue" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
        <Table headers={["Method", "Orders", "Revenue"]} rows={data.paymentTrend.map((row) => [row.method, String(row.orders), money(row.revenue)])} />
      </div>
    );
  }
  if (report === "workforce") {
    return (
      <div className="space-y-4">
        <Numbers items={[["Shifts", data.workforce.length], ["Active", data.totals.activeShiftCount], ["Shift revenue", money(data.workforce.reduce((sum, row) => sum + row.revenue, 0))], ["Discrepancy", money(data.totals.discrepancyTotal)]]} />
        <ChartBox height="h-96">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.workforce.slice(0, 16).map((row) => ({ name: row.name.slice(0, 18), revenue: row.revenue }))} layout="vertical" margin={{ left: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis type="number" tick={tick} />
              <YAxis type="category" dataKey="name" width={110} tick={tick} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="revenue" fill="#2dd4bf" name="Revenue" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
        <Table headers={["Shift", "Status", "Orders", "Revenue", "Deposit", "Difference"]} rows={data.workforce.map((row) => [`#${row.shiftId} ${row.name}`, row.status, String(row.orderCount), money(row.revenue), money(row.depositAmount), money(row.differenceAmount)])} />
      </div>
    );
  }
  return (
    <Card className="rounded-sm border-border/50">
      <CardHeader className="bg-muted/10 border-b border-border/50"><CardTitle className="text-sm uppercase tracking-wider">Receipt reprints</CardTitle></CardHeader>
      <CardContent className="pt-2 divide-y divide-border/40">
        {data.receipts.length === 0 ? <div className="text-sm text-muted-foreground py-6">No orders in this filter.</div> : data.receipts.map((receipt) => (
          <div key={receipt.orderId} className="py-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Order #{receipt.orderId}</div>
              <div className="text-xs text-muted-foreground">{new Date(receipt.createdAt).toLocaleString()} · {receipt.paymentStatus} · {receipt.paymentMethod ?? "cash"} · {money(receipt.total)}</div>
            </div>
            <Button asChild size="sm" variant="outline" className="rounded-sm"><a href={`/api/print/orders/${receipt.orderId}/receipt`} target="_blank" rel="noreferrer">Reprint</a></Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SalesReport({ view, data }: { view: SalesView; data: ReportsSummary }) {
  const topProduct = data.productPerformance[0];
  const topCsr = data.salesByCsr[0];
  return (
    <div className="space-y-4">
      <Numbers items={[
        ["Orders", data.totals.orderCount],
        ["Revenue", money(data.totals.revenue)],
        ["Average order", money(data.totals.averageOrderValue)],
        [view === "csr" ? "Top CSR" : "Top product", view === "csr" ? (topCsr?.name ?? "—") : (topProduct?.name ?? "—")],
      ]} />
      {view === "time" && (
        <>
          <ChartBox>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data.salesTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" tick={tick} />
                <YAxis yAxisId="orders" allowDecimals={false} tick={tick} />
                <YAxis yAxisId="revenue" orientation="right" tick={tick} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar yAxisId="orders" dataKey="orders" fill="#2dd4bf" name="Orders" radius={[3, 3, 0, 0]} />
                <Area yAxisId="revenue" dataKey="revenue" stroke="#fbbf24" fill="#fbbf24" fillOpacity={0.25} name="Revenue" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartBox>
          <Table headers={["Date", "Orders", "Revenue"]} rows={data.salesTrend.map((row) => [row.date, String(row.orders), money(row.revenue)])} />
        </>
      )}
      {view === "product" && (
        <>
          <ChartBox height="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.productPerformance.slice(0, 12).map((row) => ({ name: row.name.slice(0, 28), revenue: row.revenue }))} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis type="number" tick={tick} />
                <YAxis type="category" dataKey="name" width={150} tick={tick} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="revenue" fill="#2dd4bf" name="Revenue" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartBox>
          <Table headers={["Product", "Sold", "Revenue"]} rows={data.productPerformance.map((row) => [row.name, qty(row.quantity), money(row.revenue)])} />
        </>
      )}
      {view === "csr" && (
        <>
          <ChartBox height="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.salesByCsr.slice(0, 12).map((row) => ({ name: row.name.slice(0, 22), revenue: row.revenue, orders: row.orders }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="name" tick={tick} />
                <YAxis tick={tick} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="revenue" fill="#fbbf24" name="Revenue" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartBox>
          <Table headers={["CSR", "Orders", "Revenue"]} rows={data.salesByCsr.map((row) => [row.name, String(row.orders), money(row.revenue)])} />
        </>
      )}
    </div>
  );
}
