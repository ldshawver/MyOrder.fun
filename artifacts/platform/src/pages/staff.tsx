import { useState, useEffect, useCallback } from "react";
import { useListOrders, useGetCurrentUser, useListCatalogItems } from "@workspace/api-client-react";
import { Link } from "wouter";
import {
  ChevronRight, Package, Clock, RefreshCw, LogIn, LogOut,
  Plus, Trash2, Activity, Users, BarChart3, Boxes, Wifi, X, CheckCircle2,
  Printer, Truck, HandshakeIcon, ShieldOff, DoorOpen
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";

const STATUS_TABS = [
  { value: "pending", label: "Incoming" },
  { value: "processing", label: "In Progress" },
  { value: "ready", label: "Ready" },
];

type InventoryRow = { id: string; itemName: string; unitPrice: string; quantityStart: string; catalogItemId?: number };
type ShiftStats = {
  orderCount: number;
  totalRevenue: number;
  byItem: { catalogItemId: number; name: string; qtySold: number; revenue: number }[];
  byCustomer: { customerId: number; name: string; orderCount: number; total: number }[];
};
type EnrichedInventory = {
  id: number; catalogItemId: number | null; itemName: string; unitPrice: number;
  quantityStart: number; quantitySold: number; quantityRemaining: number;
};
type ActiveShift = {
  id: number; techId: number; status: string; ipAddress: string | null;
  clockedInAt: string; inventory: EnrichedInventory[]; stats: ShiftStats;
};

function useShift(getToken: () => Promise<string | null>) {
  const [shift, setShift] = useState<ActiveShift | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchShift = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch("/api/shifts/current", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setShift(data.shift);
      }
    } catch {}
    setLoading(false);
  }, [getToken]);

  useEffect(() => { fetchShift(); }, [fetchShift]);

  return { shift, setShift, loading, refetch: fetchShift };
}

function InventoryRow({ row, onUpdate, onRemove }: {
  row: InventoryRow;
  onUpdate: (id: string, field: keyof InventoryRow, value: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_100px_80px_32px] gap-2 items-center">
      <Input
        placeholder="Item name"
        value={row.itemName}
        onChange={e => onUpdate(row.id, "itemName", e.target.value)}
        className="h-8 text-xs rounded-xl bg-background/50 border-border/50"
      />
      <Input
        placeholder="Unit $"
        type="number"
        step="0.01"
        value={row.unitPrice}
        onChange={e => onUpdate(row.id, "unitPrice", e.target.value)}
        className="h-8 text-xs rounded-xl bg-background/50 border-border/50"
      />
      <Input
        placeholder="Qty"
        type="number"
        value={row.quantityStart}
        onChange={e => onUpdate(row.id, "quantityStart", e.target.value)}
        className="h-8 text-xs rounded-xl bg-background/50 border-border/50"
      />
      <button
        onClick={() => onRemove(row.id)}
        className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-red-400 transition-colors"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function ClockInPanel({ onClockIn }: { onClockIn: (inv: InventoryRow[]) => Promise<void> }) {
  const [inventory, setInventory] = useState<InventoryRow[]>([
    { id: crypto.randomUUID(), itemName: "", unitPrice: "", quantityStart: "" },
  ]);
  const [clocking, setClocking] = useState(false);

  const addRow = () =>
    setInventory(prev => [...prev, { id: crypto.randomUUID(), itemName: "", unitPrice: "", quantityStart: "" }]);

  const updateRow = (id: string, field: keyof InventoryRow, value: string) =>
    setInventory(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));

  const removeRow = (id: string) =>
    setInventory(prev => prev.filter(r => r.id !== id));

  const handleSubmit = async () => {
    setClocking(true);
    try {
      await onClockIn(inventory.filter(r => r.itemName.trim()));
    } finally {
      setClocking(false);
    }
  };

  return (
    <div className="glass-card rounded-2xl overflow-hidden border border-primary/20">
      <div className="px-6 py-5 border-b border-border/40 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Activity size={16} className="text-primary" />
        </div>
        <div>
          <div className="text-sm font-bold">Start Your Shift</div>
          <div className="text-xs text-muted-foreground">Enter starting inventory to clock in</div>
        </div>
      </div>

      <div className="px-6 py-5 space-y-4">
        {/* Column headers */}
        <div className="grid grid-cols-[1fr_100px_80px_32px] gap-2 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest px-0.5">
          <span>Item Name</span>
          <span>Unit Price</span>
          <span>Start Qty</span>
          <span />
        </div>

        {inventory.map(row => (
          <InventoryRow key={row.id} row={row} onUpdate={updateRow} onRemove={removeRow} />
        ))}

        <Button
          variant="ghost"
          size="sm"
          onClick={addRow}
          className="text-xs text-primary hover:bg-primary/5 rounded-xl h-8 px-3"
        >
          <Plus size={12} className="mr-1" />
          Add Item
        </Button>

        <div className="pt-2">
          <Button
            className="w-full rounded-xl h-10 font-bold text-sm shadow-lg shadow-primary/20"
            onClick={handleSubmit}
            disabled={clocking}
            data-testid="button-clock-in"
          >
            <LogIn size={15} className="mr-2" />
            {clocking ? "Clocking In..." : "Clock In & Start Shift"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ShiftSummaryModal({ summary, onClose }: {
  summary: { shift: ActiveShift | null; stats: ShiftStats; inventorySummary: { itemName: string; unitPrice: number; quantityStart: number; quantitySold: number; quantityRemaining: number }[]; clockedInAt: string; clockedOutAt: string } | null;
  onClose: () => void;
}) {
  if (!summary) return null;
  const duration = summary.clockedOutAt && summary.clockedInAt
    ? Math.round((new Date(summary.clockedOutAt).getTime() - new Date(summary.clockedInAt).getTime()) / 60000)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass-card rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto border border-emerald-500/20">
        <div className="px-6 py-5 border-b border-border/40 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <CheckCircle2 size={16} className="text-emerald-400" />
            </div>
            <div>
              <div className="text-sm font-bold">Shift Complete</div>
              <div className="text-xs text-muted-foreground">{duration} min · {summary.stats.orderCount} orders</div>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Totals */}
          <div className="grid grid-cols-2 gap-3">
            <div className="glass-card rounded-xl p-3 border-emerald-500/15 bg-emerald-500/5">
              <div className="text-[10px] font-semibold text-emerald-400 uppercase tracking-widest mb-1">Revenue</div>
              <div className="text-xl font-bold text-emerald-400">${summary.stats.totalRevenue.toFixed(2)}</div>
            </div>
            <div className="glass-card rounded-xl p-3">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1">Orders Filled</div>
              <div className="text-xl font-bold">{summary.stats.orderCount}</div>
            </div>
          </div>

          {/* Items sold */}
          {summary.stats.byItem.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3">Items Sold</div>
              <div className="divide-y divide-border/30 rounded-xl overflow-hidden border border-border/30">
                {summary.stats.byItem.map(item => (
                  <div key={item.catalogItemId} className="flex justify-between items-center px-4 py-3">
                    <div className="text-sm font-medium">{item.name}</div>
                    <div className="text-right">
                      <div className="text-sm font-bold font-mono">{item.qtySold} units</div>
                      <div className="text-xs text-emerald-400">${item.revenue.toFixed(2)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* By customer */}
          {summary.stats.byCustomer.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3">By Customer</div>
              <div className="divide-y divide-border/30 rounded-xl overflow-hidden border border-border/30">
                {summary.stats.byCustomer.map(c => (
                  <div key={c.customerId} className="flex justify-between items-center px-4 py-3">
                    <div>
                      <div className="text-sm font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{c.orderCount} order{c.orderCount !== 1 ? "s" : ""}</div>
                    </div>
                    <div className="text-sm font-bold font-mono">${c.total.toFixed(2)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Updated inventory */}
          {summary.inventorySummary.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3">Inventory Update</div>
              <div className="divide-y divide-border/30 rounded-xl overflow-hidden border border-border/30">
                <div className="grid grid-cols-4 gap-0 px-4 py-2 bg-muted/10 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                  <span>Item</span><span className="text-right">Start</span><span className="text-right">Sold</span><span className="text-right">Left</span>
                </div>
                {summary.inventorySummary.map((item, i) => (
                  <div key={i} className="grid grid-cols-4 gap-0 px-4 py-3">
                    <div className="text-sm font-medium truncate pr-2">{item.itemName}</div>
                    <div className="text-sm font-mono text-right">{item.quantityStart}</div>
                    <div className="text-sm font-mono text-right text-orange-400">{item.quantitySold}</div>
                    <div className={`text-sm font-bold font-mono text-right ${item.quantityRemaining === 0 ? "text-red-400" : "text-emerald-400"}`}>
                      {item.quantityRemaining}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-6 pb-6">
          <Button className="w-full rounded-xl" onClick={onClose}>
            Close Summary
          </Button>
        </div>
      </div>
    </div>
  );
}

function ActiveShiftPanel({ shift, onClockOut }: { shift: ActiveShift; onClockOut: () => void }) {
  const duration = Math.round((Date.now() - new Date(shift.clockedInAt).getTime()) / 60000);
  const [tab, setTab] = useState<"overview" | "customers" | "inventory">("overview");

  return (
    <div className="glass-card rounded-2xl overflow-hidden border border-emerald-500/20 bg-emerald-500/[0.02]">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border/40 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <Activity size={16} className="text-emerald-400" />
            </div>
            <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-400 rounded-full border-2 border-background animate-pulse" />
          </div>
          <div>
            <div className="text-sm font-bold text-emerald-400">Shift Active</div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock size={10} />
              {duration} min
              {shift.ipAddress && (
                <>
                  <span className="opacity-40">·</span>
                  <Wifi size={10} />
                  <span className="font-mono">{shift.ipAddress}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:border-red-500/60 rounded-xl text-xs font-semibold h-8"
          onClick={onClockOut}
          data-testid="button-clock-out"
        >
          <LogOut size={12} className="mr-1.5" />
          Clock Out
        </Button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 divide-x divide-border/30 border-b border-border/30">
        <div className="px-5 py-3 text-center">
          <div className="text-lg font-bold">{shift.stats.orderCount}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Orders</div>
        </div>
        <div className="px-5 py-3 text-center">
          <div className="text-lg font-bold text-emerald-400">${shift.stats.totalRevenue.toFixed(2)}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Revenue</div>
        </div>
        <div className="px-5 py-3 text-center">
          <div className="text-lg font-bold">{shift.stats.byItem.reduce((s, i) => s + i.qtySold, 0)}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Units Sold</div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-0 border-b border-border/30">
        {[
          { key: "overview" as const, label: "Items Sold", icon: BarChart3 },
          { key: "customers" as const, label: "By Customer", icon: Users },
          { key: "inventory" as const, label: "Inventory", icon: Boxes },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold transition-all border-b-2 ${
              tab === key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon size={11} />
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="px-0 py-0 min-h-[120px]">
        {tab === "overview" && (
          shift.stats.byItem.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">No items sold yet</div>
          ) : (
            <div className="divide-y divide-border/20">
              {shift.stats.byItem.map(item => (
                <div key={item.catalogItemId} className="flex justify-between items-center px-6 py-3 hover:bg-white/[0.02]">
                  <div className="text-sm font-medium">{item.name}</div>
                  <div className="flex items-center gap-4">
                    <div className="text-xs text-muted-foreground">{item.qtySold} units</div>
                    <div className="text-sm font-bold font-mono text-emerald-400">${item.revenue.toFixed(2)}</div>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === "customers" && (
          shift.stats.byCustomer.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">No customers served yet</div>
          ) : (
            <div className="divide-y divide-border/20">
              {shift.stats.byCustomer.map(c => (
                <div key={c.customerId} className="flex justify-between items-center px-6 py-3 hover:bg-white/[0.02]">
                  <div>
                    <div className="text-sm font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.orderCount} order{c.orderCount !== 1 ? "s" : ""}</div>
                  </div>
                  <div className="text-sm font-bold font-mono">${c.total.toFixed(2)}</div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === "inventory" && (
          shift.inventory.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">No inventory tracked</div>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_60px_60px_60px] gap-0 px-6 py-2 bg-muted/10 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest border-b border-border/20">
                <span>Item</span><span className="text-right">Start</span><span className="text-right">Sold</span><span className="text-right">Left</span>
              </div>
              <div className="divide-y divide-border/20">
                {shift.inventory.map(item => (
                  <div key={item.id} className="grid grid-cols-[1fr_60px_60px_60px] gap-0 px-6 py-3 hover:bg-white/[0.02]">
                    <div className="text-sm font-medium truncate pr-2">{item.itemName}</div>
                    <div className="text-sm font-mono text-right">{item.quantityStart}</div>
                    <div className="text-sm font-mono text-right text-orange-400">{item.quantitySold}</div>
                    <div className={`text-sm font-bold font-mono text-right ${
                      item.quantityRemaining === 0 ? "text-red-400" : item.quantityRemaining <= 3 ? "text-orange-400" : "text-emerald-400"
                    }`}>
                      {item.quantityRemaining}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}

const FULFILLMENT_STEPS = [
  { status: "ready_behind_gate", label: "Ready Behind Gate", icon: DoorOpen, color: "blue" },
  { status: "courier_arrived",   label: "Courier Arrived",   icon: Truck,         color: "yellow" },
  { status: "handed_off",        label: "Handed Off",        icon: HandshakeIcon, color: "emerald" },
  { status: "complete",          label: "Complete & Purge",  icon: ShieldOff,     color: "red" },
];

function FulfillmentCard({ order, onRefresh, getToken }: {
  order: any;
  onRefresh: () => void;
  getToken: () => Promise<string | null>;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [printingReceipt, setPrintingReceipt] = useState(false);
  const [printingLabel, setPrintingLabel] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const fulfillment = order.fulfillmentStatus as string | null;

  async function setFulfillmentStatus(status: string) {
    setLoading(status);
    try {
      const token = await getToken();
      await fetch(`/api/orders/${order.id}/fulfillment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fulfillmentStatus: status }),
      });
      onRefresh();
    } catch {} finally { setLoading(null); }
  }

  async function printReceipt() {
    setPrintingReceipt(true);
    try {
      const token = await getToken();
      await fetch(`/api/print/orders/${order.id}/receipt`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {} finally { setPrintingReceipt(false); }
  }

  async function printLabel() {
    setPrintingLabel(true);
    try {
      const token = await getToken();
      await fetch(`/api/print/orders/${order.id}/label`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {} finally { setPrintingLabel(false); }
  }

  const activeStep = FULFILLMENT_STEPS.findIndex(s => s.status === fulfillment);

  return (
    <div className="glass-card rounded-2xl border border-border/40 overflow-hidden" data-testid={`row-queue-${order.id}`}>
      {/* Header row */}
      <div className="p-4 flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <span className="text-xs font-mono font-bold text-primary">#{order.id}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold truncate">{order.customerName || "Unknown"}</span>
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${order.paymentStatus === "paid" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" : "bg-yellow-500/15 text-yellow-400 border-yellow-500/20"}`}>
              {order.paymentStatus === "paid" ? "PAID" : order.paymentStatus?.toUpperCase()}
            </span>
            {fulfillment && (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-primary/20 bg-primary/10 text-primary capitalize">
                {fulfillment.replace(/_/g, " ")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            <span className="flex items-center gap-1"><Clock size={10} />{new Date(order.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span>{order.items.length} item{order.items.length !== 1 ? "s" : ""}</span>
            <span className="font-mono font-bold text-foreground">${order.total?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </div>
        </div>
        <button onClick={() => setExpanded(e => !e)} className="text-muted-foreground hover:text-foreground p-1">
          <ChevronRight size={16} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
      </div>

      {/* Line items (dual-brand display) */}
      {expanded && (
        <div className="border-t border-border/30 bg-muted/10 px-4 py-3 space-y-2">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">Line Items</div>
          {order.items.map((item: any, i: number) => (
            <div key={i} className="flex items-start gap-3 text-xs py-2 border-b border-border/20 last:border-0">
              <div className="flex-1">
                <div className="font-semibold">{item.labName || item.catalogItemName}</div>
                {item.luciferCruzName && item.luciferCruzName !== item.catalogItemName && (
                  <div className="text-muted-foreground text-[11px] mt-0.5">LC: {item.luciferCruzName}</div>
                )}
                {item.receiptName && (
                  <div className="text-muted-foreground/60 text-[10px]">Receipt: {item.receiptName}</div>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="font-mono">×{item.quantity}</div>
                <div className="text-muted-foreground font-mono">${item.unitPrice?.toFixed(2)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Print buttons */}
      <div className="border-t border-border/30 px-4 py-2.5 flex items-center gap-2">
        <Button
          size="sm" variant="outline"
          className="gap-1.5 text-xs h-7 rounded-lg border-border/50"
          onClick={printReceipt}
          disabled={printingReceipt}
        >
          {printingReceipt ? <RefreshCw size={11} className="animate-spin" /> : <Printer size={11} />}
          Receipt
        </Button>
        <Button
          size="sm" variant="outline"
          className="gap-1.5 text-xs h-7 rounded-lg border-border/50"
          onClick={printLabel}
          disabled={printingLabel}
        >
          {printingLabel ? <RefreshCw size={11} className="animate-spin" /> : <Printer size={11} />}
          Label
        </Button>
        <Link href={`/orders/${order.id}`} className="ml-auto text-[11px] text-muted-foreground hover:text-foreground transition-colors">
          View Detail →
        </Link>
      </div>

      {/* Fulfillment action buttons */}
      <div className="border-t border-border/30 px-4 py-3">
        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">Fulfillment</div>
        <div className="flex flex-wrap gap-2">
          {FULFILLMENT_STEPS.map((step, idx) => {
            const isDone = activeStep >= idx;
            const isActive = fulfillment === step.status;
            const Icon = step.icon;
            const isLast = idx === FULFILLMENT_STEPS.length - 1;
            return (
              <button
                key={step.status}
                disabled={loading === step.status}
                onClick={() => setFulfillmentStatus(step.status)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border transition-all ${
                  isActive
                    ? isLast
                      ? "bg-red-500/20 border-red-500/40 text-red-400"
                      : "bg-primary/15 border-primary/40 text-primary"
                    : isDone && !isLast
                    ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                    : "bg-muted/20 border-border/40 text-muted-foreground hover:border-border"
                }`}
              >
                {loading === step.status
                  ? <RefreshCw size={11} className="animate-spin" />
                  : isDone && !isActive && !isLast
                  ? <CheckCircle2 size={11} />
                  : <Icon size={11} />}
                {step.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function BusinessSitterQueue() {
  const [activeTab, setActiveTab] = useState("pending");
  const [summaryData, setSummaryData] = useState<any>(null);
  const [clockingOut, setClockingOut] = useState(false);
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });

  const { shift, setShift, loading: shiftLoading, refetch: refetchShift } = useShift(getToken);

  const { data, isLoading } = useListOrders(
    { status: activeTab as any, limit: 50 },
    { query: { queryKey: ["listOrders", activeTab] } }
  );

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["listOrders"] });
    refetchShift();
  };

  // Auto-refresh shift stats every 30s while active
  useEffect(() => {
    if (!shift) return;
    const timer = setInterval(refetchShift, 30_000);
    return () => clearInterval(timer);
  }, [shift, refetchShift]);

  const handleClockIn = async (inventory: InventoryRow[]) => {
    const token = await getToken();
    const res = await fetch("/api/shifts/clock-in", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        inventory: inventory.map(r => ({
          itemName: r.itemName,
          unitPrice: parseFloat(r.unitPrice) || 0,
          quantityStart: parseInt(r.quantityStart) || 0,
          catalogItemId: r.catalogItemId,
        })),
      }),
    });
    if (res.ok) {
      await refetchShift();
    }
  };

  const handleClockOut = async () => {
    setClockingOut(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/shifts/clock-out", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setShift(null);
        setSummaryData(data.summary);
      }
    } finally {
      setClockingOut(false);
    }
  };

  const isStaff = user?.role === "staff" || user?.role === "tenant_admin" || user?.role === "global_admin";

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-title">
            Sitter Queue
          </h1>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-subtitle">
            Business sitter fulfillment dashboard
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-xl"
          onClick={refresh}
          title="Refresh"
        >
          <RefreshCw size={16} />
        </Button>
      </div>

      {/* Shift management panel */}
      {isStaff && (
        shiftLoading ? (
          <div className="h-24 animate-pulse bg-muted/20 rounded-2xl" />
        ) : shift ? (
          <ActiveShiftPanel
            shift={shift}
            onClockOut={handleClockOut}
          />
        ) : (
          <ClockInPanel onClockIn={handleClockIn} />
        )
      )}

      {/* Clock-out in progress */}
      {clockingOut && (
        <div className="glass-card rounded-2xl p-4 text-center text-xs text-muted-foreground animate-pulse border border-border/40">
          Clocking out and computing shift summary...
        </div>
      )}

      {/* Order queue */}
      <div className="space-y-4">
        <div className="flex gap-1 p-1 bg-muted/20 border border-border/40 rounded-xl w-fit">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`px-4 py-2 rounded-lg text-xs font-semibold tracking-wider uppercase transition-all ${
                activeTab === tab.value
                  ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse bg-muted/20 rounded-2xl" />
            ))}
          </div>
        ) : data?.orders?.length === 0 ? (
          <div className="glass-card rounded-2xl flex flex-col items-center justify-center py-20 text-center">
            <div className="w-14 h-14 rounded-2xl bg-muted/20 flex items-center justify-center mb-4">
              <Package size={24} className="text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-sm mb-1">Queue is clear</h3>
            <p className="text-xs text-muted-foreground">No {activeTab} orders right now.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {data?.orders?.map((order) => (
              <FulfillmentCard key={order.id} order={order} onRefresh={() => queryClient.invalidateQueries({ queryKey: ["listOrders"] })} getToken={getToken} />
            ))}
          </div>
        )}
      </div>

      {/* End-of-shift summary modal */}
      {summaryData && (
        <ShiftSummaryModal
          summary={summaryData}
          onClose={() => setSummaryData(null)}
        />
      )}
    </div>
  );
}
