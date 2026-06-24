import { Component, type ErrorInfo, type ReactNode, useState, useEffect, useCallback } from "react";
import { useGetCurrentUser, type Order, type OrderItem } from "@workspace/api-client-react";
import { CsrAlertBanner } from "@/components/CsrAlertBanner";
import { useOrderEvents } from "@/hooks/useOrderEvents";
import { DebugPanel, type DebugEntry } from "@/components/debug-panel";

import { Link } from "wouter";
import {
  ChevronRight, Package, Clock, RefreshCw, LogIn, LogOut,
  Activity, Users, BarChart3, Boxes, Wifi, X, CheckCircle2,
  Printer, Truck, HandshakeIcon, DoorOpen, AlertTriangle, Loader2,
  CreditCard, Banknote, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";

type ExtendedOrder = Order & { fulfillmentStatus?: string; paymentMethod?: string };
type ExtendedOrderItem = OrderItem & { labName?: string; luciferCruzName?: string; receiptName?: string };

function safeArray<T>(value: T[] | null | undefined): T[];
function safeArray<T>(value: unknown): T[];
function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function formatCourierEta(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const STATUS_TABS = [
  { value: "pending", label: "Incoming" },
  { value: "processing", label: "In Progress" },
  { value: "ready", label: "Ready" },
];

// ─── Types ────────────────────────────────────────────────────────────────────

type TemplateRow = {
  id: number;
  sectionName: string | null;
  itemName: string | null;
  rowType: string;
  unitType: string;
  startingQuantityDefault: number;
  catalogItemId: number | null;
  displayOrder: number;
  menuPrice: number | null;
  payoutPrice: number | null;
};

type InventorySnapshot = { templateItemId: number; quantityStart: number };
type CsrBoxOption = { id: string; label: string };
type ShiftLocationOption = { id: string; label: string; address?: string; pickupInstructionId?: string; deliveryOptionId?: string };
type DeliveryOption = { id: string; label: string; instructions?: string; separatePaymentRequired?: boolean };
type PrinterNetworkConfig = { onsiteMode: string; ssid: string; passwordSet?: boolean; raspberryPiBluetooth?: boolean; approvedSsids?: string[] };
type ShiftSetup = {
  boxAssignmentId: string;
  shiftLocationId: string;
  deliveryOptionId: string;
  wifiReady: boolean;
  printerReady: boolean;
  locationReady: boolean;
  csrDeliveryOptIn?: boolean;
  wifiSsid?: string;
  pickupNote?: string;
};

type EnrichedItem = {
  id: number;
  templateItemId: number | null;
  sectionName: string | null;
  rowType: string;
  unitType: string;
  displayOrder: number;
  catalogItemId: number | null;
  itemName: string;
  unitPrice: number;
  quantityStart: number;
  quantitySold: number;
  quantityEnd: number | null;
  quantityEndActual: number | null;
  discrepancy: number | null;
  isFlagged: boolean;
};

type ShiftStats = {
  orderCount: number;
  totalRevenue: number;
  cashSales: number;
  cardSales: number;
  compSales: number;
  paymentTotals?: Record<string, number>;
  byItem: { catalogItemId: number; name: string; qtySold: number; revenue: number }[];
  byCustomer: { customerId: number; name: string; orderCount: number; total: number; paymentMethod: string }[];
};

type ActiveShift = {
  id: number;
  techId: number;
  status: string;
  ipAddress: string | null;
  boxAssignmentId: string | null;
  clockedInAt: string;
  cashBankStart: number;
  runningCashBank: number;
  csrDeliveryOptIn: boolean;
  csrDeliveryEarnings: number;
  inventory: EnrichedItem[];
  stats: ShiftStats;
};


type RawShift = Partial<ActiveShift> & {
  tech_id?: number | null;
  box_assignment_id?: string | null;
  setup_json?: unknown;
};

const emptyShiftStats = (): ShiftStats => ({
  orderCount: 0,
  totalRevenue: 0,
  cashSales: 0,
  cardSales: 0,
  compSales: 0,
  paymentTotals: {},
  byItem: [],
  byCustomer: [],
});

function normalizeActiveShift(raw: RawShift | null | undefined): ActiveShift | null {
  if (!raw || raw.status == null) return null;
  const stats = raw.stats ?? emptyShiftStats();
  return {
    id: Number(raw.id ?? 0),
    techId: Number(raw.techId ?? raw.tech_id ?? 0),
    status: String(raw.status),
    ipAddress: raw.ipAddress ?? null,
    boxAssignmentId: raw.boxAssignmentId ?? raw.box_assignment_id ?? null,
    clockedInAt: raw.clockedInAt ?? new Date().toISOString(),
    cashBankStart: Number(raw.cashBankStart ?? 0),
    runningCashBank: Number(raw.runningCashBank ?? raw.cashBankStart ?? 0),
    csrDeliveryOptIn: Boolean(raw.csrDeliveryOptIn),
    csrDeliveryEarnings: Number(raw.csrDeliveryEarnings ?? 0),
    inventory: safeArray<EnrichedItem>(raw.inventory),
    stats: {
      ...emptyShiftStats(),
      ...stats,
      paymentTotals: stats.paymentTotals ?? {},
      byItem: safeArray<ShiftStats["byItem"][number]>(stats.byItem),
      byCustomer: safeArray<ShiftStats["byCustomer"][number]>(stats.byCustomer),
    },
  };
}

class StaffErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Staff page crashed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="max-w-2xl mx-auto rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-red-100" data-testid="staff-error-card">
          <div className="flex items-center gap-2 text-lg font-bold text-red-300">
            <AlertTriangle size={18} /> Staff dashboard hit an error
          </div>
          <p className="mt-2 text-sm text-red-100/80">Refresh the page or contact support if this keeps happening.</p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-xl bg-black/30 p-3 text-xs text-red-100/80">
            {this.state.error.message}
          </pre>
          <Button className="mt-4 rounded-xl" onClick={() => window.location.reload()}>Reload /staff</Button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Shift hook ───────────────────────────────────────────────────────────────

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
        setShift(normalizeActiveShift(data.shift as RawShift));
      }
    } catch { /* ignore fetch errors */ }
    setLoading(false);
  }, [getToken]);

  useEffect(() => { fetchShift(); }, [fetchShift]);

  return { shift, setShift, loading, refetch: fetchShift };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtQty(n: number | null | undefined, unitType: string) {
  if (n == null) return "—";
  return unitType === "G" ? `${n.toFixed(1)} g` : String(n);
}

function fmtMoney(n: number) {
  return `$${n.toFixed(2)}`;
}

function normalizeUiRole(role: string | null | undefined): "global_admin" | "admin" | "supervisor" | "csr" | "user" {
  const normalized = role?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "global_admin") return "global_admin";
  if (normalized === "admin") return "admin";
  if (normalized === "supervisor") return "supervisor";
  if (normalized === "csr" || normalized === "customer_service_representative" || normalized === "csr" || normalized === "qsr" || normalized === "customer_service" || normalized === "customer_service_specialist" || normalized === "customer_success" || normalized === "service_rep" || normalized === "business_sitter" || normalized === "sales_rep" || normalized === "lab_tech" || normalized === "lab_technician") {
    return "csr";
  }
  return "user";
}

// ─── Clock-In Panel ───────────────────────────────────────────────────────────

const CLOCK_IN_DEFAULT_BOXES: CsrBoxOption[] = [
  { id: "sales-box-1", label: "CSR Sales Box 1" },
  { id: "sales-box-2", label: "CSR Sales Box 2" },
];

function ClockInPanel({ onClockIn, getToken }: {
  onClockIn: (snapshot: InventorySnapshot[], cashBankStart: number, setup: ShiftSetup) => Promise<void>;
  getToken: () => Promise<string | null>;
}) {
  const [template, setTemplate] = useState<TemplateRow[]>([]);
  const [boxes, setBoxes] = useState<CsrBoxOption[]>(CLOCK_IN_DEFAULT_BOXES);
  const [boxAssignmentId, setBoxAssignmentId] = useState("sales-box-1");
  const [shiftLocations, setShiftLocations] = useState<ShiftLocationOption[]>([]);
  const [deliveryOptions, setDeliveryOptions] = useState<DeliveryOption[]>([]);
  const [printerNetworkConfig, setPrinterNetworkConfig] = useState<PrinterNetworkConfig | null>(null);
  const [shiftLocationId, setShiftLocationId] = useState("sales-box-1");
  const [deliveryOptionId, setDeliveryOptionId] = useState("pickup");
  const [wifiReady, setWifiReady] = useState(false);
  const [printerReady, setPrinterReady] = useState(false);
  const [locationReady, setLocationReady] = useState(false);
  const [wifiSsid, setWifiSsid] = useState("");
  const [pickupNote, setPickupNote] = useState("");
  const [csrDeliveryOptIn, setCsrDeliveryOptIn] = useState(false);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [cashBankStart, setCashBankStart] = useState("100");
  const [loadingTemplate, setLoadingTemplate] = useState(true);
  const [clocking, setClocking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoadingTemplate(true);
      try {
        const token = await getToken();
        const res = await fetch("/api/shifts/inventory-template", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          const rows = safeArray<TemplateRow>(data.template);
          const safeBoxes = safeArray<CsrBoxOption>(data.boxes);
          const boxOptions: CsrBoxOption[] = safeBoxes.length > 0 ? safeBoxes : CLOCK_IN_DEFAULT_BOXES;
          setTemplate(rows);
          setBoxes(boxOptions);
          const nextShiftLocations = safeArray<ShiftLocationOption>(data.shiftLocationOptions);
          const nextDeliveryOptions = safeArray<DeliveryOption>(data.deliveryOptions);
          setShiftLocations(nextShiftLocations);
          setDeliveryOptions(nextDeliveryOptions);
          setPrinterNetworkConfig(data.printerNetworkConfig ?? null);
          setBoxAssignmentId(prev => boxOptions.some(box => box.id === prev) ? prev : (boxOptions[0]?.id ?? "sales-box-1"));
          setShiftLocationId(prev => nextShiftLocations.some(location => location.id === prev) ? prev : (nextShiftLocations[0]?.id ?? boxOptions[0]?.id ?? "sales-box-1"));
          setDeliveryOptionId(prev => nextDeliveryOptions.some(option => option.id === prev) ? prev : (nextDeliveryOptions[0]?.id ?? "pickup"));
          const defaults: Record<number, string> = {};
          for (const row of rows) {
            if (row.rowType === "item" || row.rowType === "cash") {
              defaults[row.id] = String(row.startingQuantityDefault ?? 0);
            }
          }
          setQuantities(defaults);
        } else if (res.status === 403) {
          setError("Access denied — your account doesn't have CSR shift access yet. Ask an admin to open Admin → Users, find your account, and set your role to \"Customer Service Rep\".");
        } else {
          setError(`Failed to load inventory template (${res.status}). Please refresh or contact support.`);
        }
      } catch {
        setError("Could not reach the server. Check your connection and try again.");
      }
      setLoadingTemplate(false);
    }
    load();
  }, [getToken]);

  const mandatoryChecksComplete = wifiReady && printerReady && locationReady;
  const safeApprovedSsids = safeArray<string>(printerNetworkConfig?.approvedSsids);

  const handleSubmit = async () => {
    if (!mandatoryChecksComplete) {
      setError("Confirm WiFi, printer, and pickup/location before clocking in.");
      return;
    }
    setClocking(true);
    setError(null);
    try {
      const snapshot: InventorySnapshot[] = template
        .filter(r => r.rowType === "item" || r.rowType === "cash")
        .map(r => ({
          templateItemId: r.id,
          quantityStart: parseFloat(quantities[r.id] ?? "0") || 0,
        }));
      await onClockIn(snapshot, parseFloat(cashBankStart) || 0, {
        boxAssignmentId,
        shiftLocationId,
        deliveryOptionId,
        wifiReady,
        printerReady,
        locationReady,
        csrDeliveryOptIn,
        wifiSsid: wifiSsid.trim(),
        pickupNote: pickupNote.trim(),
      });
    } catch (err) {
      setError((err as Error).message ?? "Clock-in failed. Please try again.");
    } finally {
      setClocking(false);
    }
  };

  if (loadingTemplate) {
    return (
      <div className="glass-card rounded-2xl p-6 flex items-center justify-center gap-3 border border-primary/20">
        <Loader2 size={16} className="animate-spin text-primary" />
        <span className="text-sm text-muted-foreground">Loading inventory template…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-card rounded-2xl p-6 border border-red-500/20 text-center text-sm text-red-400">
        {error}
      </div>
    );
  }

  const sections: { name: string; items: TemplateRow[] }[] = [];
  let currentSection: { name: string; items: TemplateRow[] } | null = null;
  for (const row of template) {
    if (row.rowType === "section") {
      currentSection = { name: row.sectionName ?? row.itemName ?? "", items: [] };
      sections.push(currentSection);
    } else if (row.rowType === "spacer") {
      currentSection = null;
    } else if (row.rowType === "item" || row.rowType === "cash") {
      const targetSection = row.rowType === "item" ? (row.sectionName ?? "") : "";
      if (!currentSection || currentSection.name !== targetSection) {
        currentSection = { name: targetSection, items: [] };
        sections.push(currentSection);
      }
      currentSection.items.push(row);
    }
  }

  return (
    <div className="glass-card rounded-2xl overflow-hidden border border-primary/20">
      <div className="px-6 py-5 border-b border-border/40 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Activity size={16} className="text-primary" />
        </div>
        <div>
          <div className="text-sm font-bold">Start Your Shift</div>
          <div className="text-xs text-muted-foreground">Select tenant-wide location/delivery options, confirm inventory, then become active for orders</div>
        </div>
      </div>

      <div className="px-6 py-4 border-b border-border/40">
        <div className="text-[10px] font-bold text-primary uppercase tracking-widest mb-3 flex items-center gap-1.5">
          <Boxes size={11} />
          Box Assignment & Setup
        </div>
        <div className="grid gap-3 md:grid-cols-3 md:items-end">
          <label className="block">
            <span className="text-xs text-muted-foreground mb-1 block">Assigned sales box</span>
            <select
              value={boxAssignmentId}
              onChange={e => setBoxAssignmentId(e.target.value)}
              className="h-9 w-full rounded-xl border border-border/50 bg-background/50 px-3 text-sm font-medium"
              data-testid="select-box-assignment"
            >
              {boxes.map(box => <option key={box.id} value={box.id}>{box.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground mb-1 block">Shift location</span>
            <select
              value={shiftLocationId}
              onChange={e => {
                const nextLocationId = e.target.value;
                setShiftLocationId(nextLocationId);
                const location = shiftLocations.find(option => option.id === nextLocationId);
                if (location?.deliveryOptionId) setDeliveryOptionId(location.deliveryOptionId);
                if (boxes.some(box => box.id === nextLocationId)) setBoxAssignmentId(nextLocationId);
              }}
              className="h-9 w-full rounded-xl border border-border/50 bg-background/50 px-3 text-sm font-medium"
              data-testid="select-shift-location"
            >
              {(shiftLocations.length > 0 ? shiftLocations : boxes).map(location => (
                <option key={location.id} value={location.id}>{location.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground mb-1 block">Delivery option</span>
            <select
              value={deliveryOptionId}
              onChange={e => setDeliveryOptionId(e.target.value)}
              className="h-9 w-full rounded-xl border border-border/50 bg-background/50 px-3 text-sm font-medium"
              data-testid="select-delivery-option"
            >
              {(deliveryOptions.length > 0 ? deliveryOptions : [{ id: "pickup", label: "Customer Pickup" }]).map(option => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          {/* WiFi SSID entry with auto-validation */}
          <div className="md:col-span-3 space-y-2">
            <span className="text-xs text-muted-foreground block">Wi-Fi Network (SSID)</span>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  list="approved-ssids-list"
                  value={wifiSsid}
                  onChange={e => {
                    setWifiSsid(e.target.value);
                    const match = safeApprovedSsids.some(s => s.toLowerCase() === e.target.value.trim().toLowerCase());
                    setWifiReady(match);
                  }}
                  placeholder={printerNetworkConfig?.ssid || "Enter Wi-Fi network name (SSID)"}
                  className="h-9 w-full rounded-xl border border-border/50 bg-background/50 px-3 text-sm font-mono"
                  data-testid="input-wifi-ssid"
                />
                {safeApprovedSsids.length > 0 && (
                  <datalist id="approved-ssids-list">
                    {safeApprovedSsids.map((s, i) => <option key={i} value={s} />)}
                  </datalist>
                )}
              </div>
              {wifiSsid.trim() && (
                <span className={`shrink-0 text-[11px] font-semibold px-2 py-1 rounded-lg ${wifiReady ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" : "bg-amber-500/10 text-amber-400 border border-amber-500/30"}`}>
                  {wifiReady ? "✓ Approved" : "⚠ Unrecognized"}
                </span>
              )}
            </div>
            {!wifiReady && wifiSsid.trim() && safeApprovedSsids.length > 0 && (
              <div className="text-[11px] text-amber-400/80">SSID not in the approved list. Confirm your network then proceed — or ask an admin to add it.</div>
            )}
          </div>

          <div className="md:col-span-3 grid gap-3 md:grid-cols-3 md:items-center">
            <SetupCheck label="I confirm pickup/location is set" checked={locationReady} onChange={setLocationReady} />
            <SetupCheck label="I confirm WiFi is working" checked={wifiReady} onChange={setWifiReady} />
            <SetupCheck label="I confirm printer is available" checked={printerReady} onChange={setPrinterReady} />
          </div>

          {/* CSR personal delivery opt-in */}
          {deliveryOptionId && deliveryOptionId !== "pickup" && (
            <label className="md:col-span-3 flex items-start gap-3 rounded-xl border border-border/40 bg-primary/5 px-4 py-3 cursor-pointer">
              <input
                type="checkbox"
                checked={csrDeliveryOptIn}
                onChange={e => setCsrDeliveryOptIn(e.target.checked)}
                className="mt-0.5 size-4 accent-primary"
                data-testid="checkbox-csr-delivery-opt-in"
              />
              <div>
                <div className="text-xs font-semibold">I'll personally deliver orders this shift</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">Customers can choose personal delivery only within 2 miles. Fee is $6 + 3% of sale total and is shown before assignment.</div>
              </div>
            </label>
          )}

          {/* Custom pickup note */}
          <div className="md:col-span-3 space-y-1">
            <span className="text-xs text-muted-foreground block">Custom pickup note <span className="text-muted-foreground/50">(optional — shown to customers on pickup)</span></span>
            <textarea
              value={pickupNote}
              onChange={e => setPickupNote(e.target.value)}
              placeholder="e.g. Pull around to the side door, call when here…"
              rows={2}
              className="w-full rounded-xl border border-border/50 bg-background/50 px-3 py-2 text-sm resize-none"
              data-testid="textarea-pickup-note"
            />
          </div>


        </div>
      </div>

      {/* Cash bank start — prominent */}
      <div className="px-6 py-4 border-b border-border/40 bg-emerald-500/[0.03]">
        <div className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest mb-3 flex items-center gap-1.5">
          <Banknote size={11} />
          Starting Cash Bank
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-xs text-muted-foreground mb-1">Cash bank par is $100. Confirm the box starts at par or enter the counted total</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-emerald-400">$</span>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={cashBankStart}
              onChange={e => setCashBankStart(e.target.value)}
              className="h-9 w-28 text-right text-sm rounded-xl bg-background/50 border-emerald-500/30 font-mono font-bold text-emerald-400 focus:border-emerald-500/60"
              placeholder="100.00"
            />
          </div>
        </div>
      </div>

      {/* Inventory list */}
      <div className="divide-y divide-border/20">
        {sections.length === 0 && (
          <div className="px-6 py-8 text-center text-sm text-muted-foreground">
            No Alavont inventory rows are available for clock-in. Ask a supervisor to import or seed the Alavont catalog inventory.
          </div>
        )}
        {sections.map((section, si) => (
          <div key={si}>
            {section.name && (
              <div className="px-6 py-2 bg-muted/15 text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                {section.name}
              </div>
            )}
            <div className="divide-y divide-border/10">
              {section.items.map(row => (
                <div key={row.id} className="flex items-center gap-3 px-6 py-2.5">
                  <div className="flex-1 text-sm font-medium truncate">{row.itemName}</div>
                  {row.menuPrice != null && (
                    <div className="text-[10px] text-muted-foreground shrink-0 text-right w-16 font-mono">
                      <span className="text-[9px] text-muted-foreground/50 block uppercase tracking-wider">Menu</span>
                      ${row.menuPrice.toFixed(2)}
                    </div>
                  )}
                  {row.payoutPrice != null && (
                    <div className="text-[10px] text-emerald-400/80 shrink-0 text-right w-16 font-mono">
                      <span className="text-[9px] text-muted-foreground/50 block uppercase tracking-wider">Sale</span>
                      ${row.payoutPrice.toFixed(2)}
                    </div>
                  )}
                  <div className="text-[10px] text-muted-foreground shrink-0 w-8 text-center">
                    {row.unitType}
                  </div>
                  <Input
                    type="number"
                    min="0"
                    step={row.unitType === "G" ? "0.1" : "1"}
                    value={quantities[row.id] ?? "0"}
                    onChange={e => setQuantities(prev => ({ ...prev, [row.id]: e.target.value }))}
                    className="h-8 w-24 text-right text-sm rounded-xl bg-background/50 border-border/50 font-mono"
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="px-6 py-5 border-t border-border/40">
        <Button
          className="w-full rounded-xl h-10 font-bold text-sm shadow-lg shadow-primary/20"
          onClick={handleSubmit}
          disabled={clocking || !mandatoryChecksComplete}
          data-testid="button-clock-in"
        >
          <LogIn size={15} className="mr-2" />
          {clocking ? "Starting Shift…" : "Start Shift"}
        </Button>
      </div>
    </div>
  );
}

function SetupCheck({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-xl border border-border/40 bg-background/30 px-3 py-2 text-xs font-semibold">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="h-4 w-4"
      />
      {label}
    </label>
  );
}

// ─── Clock-Out Modal ──────────────────────────────────────────────────────────
// Collects ending physical inventory counts + actual cash in box before finalizing.

function ClockOutModal({ shift, onConfirm, onCancel }: {
  shift: ActiveShift;
  onConfirm: (data: { endingInventory: { shiftInventoryItemId: number; quantityEndActual: number }[]; cashBankEnd: number }) => Promise<void>;
  onCancel: () => void;
}) {
  // Pre-populate actual counts with computed expected values
  const initialCounts: Record<number, string> = {};
  const shiftInventory = safeArray<EnrichedItem>(shift.inventory);
  const shiftStats = {
    ...emptyShiftStats(),
    ...(shift.stats ?? {}),
    byItem: safeArray<ShiftStats["byItem"][number]>(shift.stats?.byItem),
    byCustomer: safeArray<ShiftStats["byCustomer"][number]>(shift.stats?.byCustomer),
  };
  for (const item of shiftInventory) {
    if (item.rowType === "item") {
      initialCounts[item.id] = String(item.quantityEnd ?? 0);
    }
  }

  const expectedCash = (shift.cashBankStart ?? 0) + (shiftStats.cashSales ?? 0);

  const [actualCounts, setActualCounts] = useState<Record<number, string>>(initialCounts);
  const [cashBankEnd, setCashBankEnd] = useState(expectedCash.toFixed(2));
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const endingInventory = shiftInventory
        .filter(i => i.rowType === "item")
        .map(i => ({
          shiftInventoryItemId: i.id,
          quantityEndActual: parseFloat(actualCounts[i.id] ?? "0") || 0,
        }));
      await onConfirm({ endingInventory, cashBankEnd: parseFloat(cashBankEnd) || 0 });
    } finally {
      setSubmitting(false);
    }
  };

  // Group items by section for display
  const sections: { name: string; items: EnrichedItem[] }[] = [];
  let currentSection: { name: string; items: EnrichedItem[] } | null = null;
  for (const item of shiftInventory) {
    if (item.rowType === "section") {
      currentSection = { name: item.sectionName ?? item.itemName, items: [] };
      sections.push(currentSection);
    } else if (item.rowType === "spacer") {
      currentSection = null;
    } else if (item.rowType === "item") {
      if (!currentSection) {
        currentSection = { name: "", items: [] };
        sections.push(currentSection);
      }
      currentSection.items.push(item);
    }
  }

  const cashActual = parseFloat(cashBankEnd) || 0;
  const cashDisc = expectedCash - cashActual;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="glass-card rounded-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto border border-orange-500/20">
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/40 flex items-center justify-between sticky top-0 bg-background/90 backdrop-blur-md z-10">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
              <LogOut size={16} className="text-orange-400" />
            </div>
            <div>
              <div className="text-sm font-bold">End of Shift — Count Inventory</div>
              <div className="text-xs text-muted-foreground">Enter actual counts to calculate discrepancies</div>
            </div>
          </div>
          <button onClick={onCancel} className="text-muted-foreground hover:text-foreground transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Cash bank reconciliation */}
          <div className="rounded-xl border border-emerald-500/20 overflow-hidden">
            <div className="px-4 py-3 bg-emerald-500/[0.06] border-b border-emerald-500/15 flex items-center gap-2">
              <Banknote size={13} className="text-emerald-400" />
              <span className="text-xs font-bold text-emerald-400 uppercase tracking-widest">Cash Bank</span>
            </div>
            <div className="divide-y divide-border/20">
              <div className="grid grid-cols-3 px-4 py-3 text-xs text-muted-foreground">
                <span>Starting Cash</span>
                <span>+ Cash Sales</span>
                <span className="font-bold text-emerald-400">= Expected Total</span>
              </div>
              <div className="grid grid-cols-3 px-4 py-3 font-mono font-bold text-sm">
                <span>{fmtMoney(shift.cashBankStart ?? 0)}</span>
                <span className="text-emerald-400">+{fmtMoney(shiftStats.cashSales ?? 0)}</span>
                <span className="text-emerald-400">{fmtMoney(expectedCash)}</span>
              </div>
              <div className="px-4 py-3 flex items-center gap-4">
                <div className="flex-1">
                  <div className="text-xs font-semibold mb-1">Actual Cash Counted</div>
                  <div className="text-xs text-muted-foreground">Count all cash in the box right now</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold">$</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={cashBankEnd}
                    onChange={e => setCashBankEnd(e.target.value)}
                    className="h-9 w-32 text-right font-mono font-bold rounded-xl bg-background/50 border-emerald-500/30 text-emerald-400"
                  />
                </div>
              </div>
              {Math.abs(cashDisc) > 0.005 && (
                <div className={`px-4 py-2.5 flex items-center gap-2 ${cashDisc > 0 ? "bg-red-500/5" : "bg-emerald-500/5"}`}>
                  <AlertTriangle size={12} className={cashDisc > 0 ? "text-red-400" : "text-emerald-400"} />
                  <span className={`text-xs font-bold ${cashDisc > 0 ? "text-red-400" : "text-emerald-400"}`}>
                    Cash discrepancy: {cashDisc > 0 ? `-${fmtMoney(cashDisc)}` : `+${fmtMoney(Math.abs(cashDisc))}`}
                    {cashDisc > 0 ? " (short)" : " (over)"}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Inventory counts */}
          <div>
            <div className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-widest mb-3">
              Ending Inventory — Enter Physical Counts
            </div>
            <div className="rounded-xl border border-border/30 overflow-hidden">
              {/* Header */}
              <div className="grid grid-cols-[1fr_72px_72px_80px] px-4 py-2 bg-muted/10 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest border-b border-border/20">
                <span>Item</span>
                <span className="text-right">Start</span>
                <span className="text-right">Sold</span>
                <span className="text-right">Actual #</span>
              </div>
              {sections.map((section, si) => (
                <div key={si}>
                  {section.name && (
                    <div className="px-4 py-1.5 bg-muted/20 text-[10px] font-bold text-muted-foreground uppercase tracking-wider border-t border-border/20">
                      {section.name}
                    </div>
                  )}
                  {section.items.map(item => {
                    const expected = item.quantityEnd ?? (item.quantityStart - item.quantitySold);
                    const actual = parseFloat(actualCounts[item.id] ?? String(expected));
                    const disc = expected - actual;
                    const hasDisc = Math.abs(disc) > 0.001;
                    return (
                      <div key={item.id} className={`grid grid-cols-[1fr_72px_72px_80px] items-center px-4 py-2.5 border-t border-border/15 ${hasDisc && disc > 0 ? "bg-red-500/5" : ""}`}>
                        <div className="text-sm font-medium truncate pr-2 flex items-center gap-1.5">
                          {hasDisc && disc > 0 && <AlertTriangle size={10} className="text-red-400 shrink-0" />}
                          {item.itemName}
                          {hasDisc && (
                            <span className={`text-[10px] font-mono ml-1 ${disc > 0 ? "text-red-400" : "text-emerald-400"}`}>
                              ({disc > 0 ? `-${disc}` : `+${Math.abs(disc)}`})
                            </span>
                          )}
                        </div>
                        <div className="text-sm font-mono text-right text-muted-foreground">{fmtQty(item.quantityStart, item.unitType)}</div>
                        <div className="text-sm font-mono text-right text-orange-400">{fmtQty(item.quantitySold, item.unitType)}</div>
                        <div className="flex justify-end">
                          <Input
                            type="number"
                            min="0"
                            step={item.unitType === "G" ? "0.1" : "1"}
                            value={actualCounts[item.id] ?? String(expected)}
                            onChange={e => setActualCounts(prev => ({ ...prev, [item.id]: e.target.value }))}
                            className={`h-7 w-20 text-right text-xs font-mono rounded-lg bg-background/50 ${hasDisc && disc > 0 ? "border-red-500/40 text-red-400" : "border-border/50"}`}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-6 pb-6 flex gap-3">
          <Button variant="outline" className="flex-1 rounded-xl border-border/50" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            className="flex-1 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-bold shadow-lg shadow-orange-500/20"
            onClick={handleSubmit}
            disabled={submitting}
            data-testid="button-clock-out"
          >
            <LogOut size={14} className="mr-2" />
            {submitting ? "Ending Shift…" : "Submit & End Shift"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Shift Summary Modal ──────────────────────────────────────────────────────

type SummaryData = {
  stats: ShiftStats;
  cashBankStart: number;
  cashBankEnd: number | null;
  expectedCashBank: number;
  cashDiscrepancy: number | null;
  reportedInventoryDifference?: number;
  differenceAmount?: number;
  inventorySummary: {
    itemName: string;
    sectionName: string | null;
    rowType: string;
    unitType: string;
    quantityStart: number;
    quantitySold: number;
    quantityEnd: number;
    quantityEndActual: number | null;
    discrepancy: number | null;
    isFlagged: boolean;
  }[];
  clockedInAt: string;
  clockedOutAt: string;
};

function normalizeSummaryData(raw: Partial<SummaryData> | null | undefined): SummaryData | null {
  if (!raw) return null;
  const stats = raw.stats ?? emptyShiftStats();
  return {
    stats: {
      ...emptyShiftStats(),
      ...stats,
      paymentTotals: stats.paymentTotals ?? {},
      byItem: safeArray<ShiftStats["byItem"][number]>(stats.byItem),
      byCustomer: safeArray<ShiftStats["byCustomer"][number]>(stats.byCustomer),
    },
    cashBankStart: Number(raw.cashBankStart ?? 0),
    cashBankEnd: raw.cashBankEnd ?? null,
    expectedCashBank: Number(raw.expectedCashBank ?? 0),
    cashDiscrepancy: raw.cashDiscrepancy ?? null,
    reportedInventoryDifference: raw.reportedInventoryDifference,
    differenceAmount: raw.differenceAmount,
    inventorySummary: safeArray<SummaryData["inventorySummary"][number]>(raw.inventorySummary),
    clockedInAt: raw.clockedInAt ?? new Date().toISOString(),
    clockedOutAt: raw.clockedOutAt ?? new Date().toISOString(),
  };
}

function ShiftSummaryModal({ summary, onClose }: {
  summary: SummaryData | null;
  onClose: () => void;
}) {
  if (!summary) return null;

  const duration = summary.clockedOutAt && summary.clockedInAt
    ? Math.round((new Date(summary.clockedOutAt).getTime() - new Date(summary.clockedInAt).getTime()) / 60000)
    : 0;

  const safeInventorySummary = safeArray<SummaryData["inventorySummary"][number]>(summary.inventorySummary);
  const safeSummaryStats = {
    ...emptyShiftStats(),
    ...(summary.stats ?? {}),
    byItem: safeArray<ShiftStats["byItem"][number]>(summary.stats?.byItem),
    byCustomer: safeArray<ShiftStats["byCustomer"][number]>(summary.stats?.byCustomer),
  };
  const flaggedItems = safeInventorySummary.filter(i => i.isFlagged);
  const hasCashDisc = summary.cashDiscrepancy != null && Math.abs(summary.cashDiscrepancy) > 0.005;
  const hasProblems = flaggedItems.length > 0 || hasCashDisc;
  const hasActualCounts = safeInventorySummary.some(i => i.rowType === "item" && i.quantityEndActual != null);
  const paymentTotals = safeSummaryStats.paymentTotals ?? {};
  const cashAppSales = paymentTotals.cashapp ?? 0;
  const venmoSales = paymentTotals.venmo ?? 0;
  const applePaySales = paymentTotals.apple_pay ?? 0;
  const zelleSales = paymentTotals.zelle ?? 0;
  const paypalSales = paymentTotals.paypal ?? 0;
  const differenceAmount = summary.differenceAmount ?? safeSummaryStats.totalRevenue;


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass-card rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-emerald-500/20">
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/40 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <CheckCircle2 size={16} className="text-emerald-400" />
            </div>
            <div>
              <div className="text-sm font-bold">Shift Complete</div>
              <div className="text-xs text-muted-foreground">{duration} min · {safeSummaryStats.orderCount} orders</div>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Problems banner */}
          {hasProblems && (
            <div className="flex items-start gap-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
              <AlertTriangle size={15} className="text-red-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-bold text-red-400 mb-1">Discrepancies Found — Report to Admin</div>
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  {hasCashDisc && (
                    <li>
                      Cash bank: expected {fmtMoney(summary.expectedCashBank)}, counted {fmtMoney(summary.cashBankEnd ?? 0)} ({summary.cashDiscrepancy! > 0 ? "short" : "over"} {fmtMoney(Math.abs(summary.cashDiscrepancy!))})
                    </li>
                  )}
                  {flaggedItems.map(i => (
                    <li key={i.itemName}>
                      {i.itemName}: expected {fmtQty(i.quantityEnd, i.unitType)}{i.quantityEndActual != null ? `, counted ${fmtQty(i.quantityEndActual, i.unitType)}` : " ended below zero"}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Revenue totals */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="glass-card rounded-xl p-3 border-emerald-500/15 bg-emerald-500/5">
              <div className="text-[10px] font-semibold text-emerald-400 uppercase tracking-widest mb-1">Total Sales</div>
              <div className="text-xl font-bold text-emerald-400">{fmtMoney(safeSummaryStats.totalRevenue)}</div>
            </div>
            <div className="glass-card rounded-xl p-3">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 flex items-center gap-1"><Banknote size={9} />Cash</div>
              <div className="text-xl font-bold">{fmtMoney(safeSummaryStats.cashSales)}</div>
            </div>
            <div className="glass-card rounded-xl p-3">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 flex items-center gap-1"><CreditCard size={9} />Card</div>
              <div className="text-xl font-bold">{fmtMoney(safeSummaryStats.cardSales)}</div>
            </div>
            <div className="glass-card rounded-xl p-3">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1">Orders</div>
              <div className="text-xl font-bold">{safeSummaryStats.orderCount}</div>
            </div>
          </div>

          {/* Payment method totals */}
          <div className="rounded-xl border border-border/30 overflow-hidden">
            <div className="px-4 py-2.5 bg-muted/10 text-[10px] font-bold text-muted-foreground uppercase tracking-widest border-b border-border/20 flex items-center gap-1.5">
              Payment Method Totals
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-border/20 text-sm">
              <PaymentStat label="Cash App" amount={cashAppSales} />
              <PaymentStat label="Venmo" amount={venmoSales} />
              <PaymentStat label="Apple Pay" amount={applePaySales} />
              <PaymentStat label="Zelle" amount={zelleSales} />
              <PaymentStat label="PayPal" amount={paypalSales} />
            </div>
          </div>

          {/* Cash bank reconciliation */}
          <div className="rounded-xl border border-border/30 overflow-hidden">
            <div className="px-4 py-2.5 bg-muted/10 text-[10px] font-bold text-muted-foreground uppercase tracking-widest border-b border-border/20 flex items-center gap-1.5">
              <Banknote size={10} />
              Cash Bank Reconciliation
            </div>
            <div className="divide-y divide-border/20 text-sm">
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-muted-foreground">Starting Cash Bank</span>
                <span className="font-mono">{fmtMoney(summary.cashBankStart)}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-muted-foreground">+ Cash Sales</span>
                <span className="font-mono text-emerald-400">+{fmtMoney(safeSummaryStats.cashSales)}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5 font-bold">
                <span>Expected Bank Total</span>
                <span className="font-mono text-emerald-400">{fmtMoney(summary.expectedCashBank)}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-muted-foreground">Difference / Total Sales</span>
                <span className="font-mono">{fmtMoney(differenceAmount)}</span>
              </div>
              {summary.cashBankEnd != null && (
                <div className="flex justify-between px-4 py-2.5">
                  <span className="text-muted-foreground">Actual Cash Counted</span>
                  <span className="font-mono">{fmtMoney(summary.cashBankEnd)}</span>
                </div>
              )}
              {hasCashDisc && (
                <div className={`flex justify-between px-4 py-2.5 font-bold ${summary.cashDiscrepancy! > 0 ? "bg-red-500/5 text-red-400" : "bg-emerald-500/5 text-emerald-400"}`}>
                  <span>Cash Discrepancy</span>
                  <span className="font-mono">
                    {summary.cashDiscrepancy! > 0 ? "-" : "+"}{fmtMoney(Math.abs(summary.cashDiscrepancy!))}
                    {summary.cashDiscrepancy! > 0 ? " (short)" : " (over)"}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Items sold */}
          {safeSummaryStats.byItem.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3">Items Sold</div>
              <div className="divide-y divide-border/30 rounded-xl overflow-hidden border border-border/30">
                {safeSummaryStats.byItem.map(item => (
                  <div key={item.catalogItemId} className="flex justify-between items-center px-4 py-3">
                    <div className="text-sm font-medium">{item.name}</div>
                    <div className="text-right">
                      <div className="text-sm font-bold font-mono">{item.qtySold} units</div>
                      <div className="text-xs text-emerald-400">{fmtMoney(item.revenue)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* By customer */}
          {safeSummaryStats.byCustomer.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3">By Customer</div>
              <div className="divide-y divide-border/30 rounded-xl overflow-hidden border border-border/30">
                {safeSummaryStats.byCustomer.map(c => (
                  <div key={c.customerId} className="flex justify-between items-center px-4 py-3">
                    <div>
                      <div className="text-sm font-medium">{c.name}</div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{c.orderCount} order{c.orderCount !== 1 ? "s" : ""}</span>
                        <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] border ${c.paymentMethod === "card" ? "bg-blue-500/10 text-blue-400 border-blue-500/20" : c.paymentMethod === "comp" ? "bg-purple-500/10 text-purple-400 border-purple-500/20" : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"}`}>
                          {c.paymentMethod ?? "cash"}
                        </span>
                      </div>
                    </div>
                    <div className="text-sm font-bold font-mono">{fmtMoney(c.total)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Inventory reconciliation */}
          {safeInventorySummary.filter(i => i.rowType === "item" || i.rowType === "section").length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3">Inventory Reconciliation</div>
              <div className="rounded-xl overflow-hidden border border-border/30">
                <div className={`grid gap-0 px-4 py-2 bg-muted/10 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest border-b border-border/20 ${hasActualCounts ? "grid-cols-[1fr_52px_52px_60px_60px_52px]" : "grid-cols-[1fr_52px_52px_60px]"}`}>
                  <span>Item</span>
                  <span className="text-right">Start</span>
                  <span className="text-right">Sold</span>
                  <span className="text-right">Expected</span>
                  {hasActualCounts && <><span className="text-right">Actual</span><span className="text-right">Diff</span></>}
                </div>
                {safeInventorySummary.map((item, i) => {
                  if (item.rowType === "section") {
                    return (
                      <div key={i} className="px-4 py-1.5 bg-muted/20 text-[10px] font-bold text-muted-foreground uppercase tracking-wider border-t border-border/20">
                        {item.itemName}
                      </div>
                    );
                  }
                  if (item.rowType === "spacer") return null;
                  const disc = item.discrepancy;
                  const hasDisc = disc != null && Math.abs(disc) > 0.001;
                  return (
                    <div key={i} className={`gap-0 px-4 py-3 border-t border-border/15 ${item.isFlagged ? "bg-red-500/5" : ""} ${hasActualCounts ? "grid grid-cols-[1fr_52px_52px_60px_60px_52px]" : "grid grid-cols-[1fr_52px_52px_60px]"}`}>
                      <div className="text-sm font-medium truncate pr-2 flex items-center gap-1.5">
                        {item.isFlagged && <AlertTriangle size={11} className="text-red-400 shrink-0" />}
                        {item.itemName}
                      </div>
                      <div className="text-sm font-mono text-right text-muted-foreground">{fmtQty(item.quantityStart, item.unitType)}</div>
                      <div className="text-sm font-mono text-right text-orange-400">{fmtQty(item.quantitySold, item.unitType)}</div>
                      <div className={`text-sm font-bold font-mono text-right ${item.isFlagged ? "text-red-400" : item.quantityEnd <= 0 ? "text-orange-400" : "text-emerald-400"}`}>
                        {fmtQty(item.quantityEnd, item.unitType)}
                      </div>
                      {hasActualCounts && (
                        <>
                          <div className={`text-sm font-mono text-right ${item.quantityEndActual == null ? "text-muted-foreground/40" : hasDisc && disc! > 0 ? "text-red-400" : "text-foreground"}`}>
                            {item.quantityEndActual != null ? fmtQty(item.quantityEndActual, item.unitType) : "—"}
                          </div>
                          <div className={`text-xs font-mono text-right font-bold ${!hasDisc ? "text-muted-foreground/30" : disc! > 0 ? "text-red-400" : "text-emerald-400"}`}>
                            {!hasDisc ? "✓" : disc! > 0 ? `-${fmtQty(Math.abs(disc!), item.unitType)}` : `+${fmtQty(Math.abs(disc!), item.unitType)}`}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
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

function PaymentStat({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="bg-background/50 px-3 py-2.5">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="font-mono font-semibold">{fmtMoney(amount)}</div>
    </div>
  );
}

// ─── Active Shift Panel ───────────────────────────────────────────────────────

function ActiveShiftPanel({ shift, onClockOut }: { shift: ActiveShift; onClockOut: () => void }) {
  const shiftInventory = safeArray<EnrichedItem>(shift.inventory);
  const shiftStats = {
    ...emptyShiftStats(),
    ...(shift.stats ?? {}),
    byItem: safeArray<ShiftStats["byItem"][number]>(shift.stats?.byItem),
    byCustomer: safeArray<ShiftStats["byCustomer"][number]>(shift.stats?.byCustomer),
  };
  const clockedInAtMs = new Date(shift.clockedInAt ?? Date.now()).getTime();
  const duration = Math.max(0, Math.round((Date.now() - (Number.isNaN(clockedInAtMs) ? Date.now() : clockedInAtMs)) / 60000));
  const [tab, setTab] = useState<"overview" | "customers" | "inventory">("overview");

  const sections: { name: string; items: EnrichedItem[] }[] = [];
  let currentSection: { name: string; items: EnrichedItem[] } | null = null;
  for (const item of shiftInventory) {
    if (item.rowType === "section") {
      currentSection = { name: item.sectionName ?? item.itemName, items: [] };
      sections.push(currentSection);
    } else if (item.rowType === "spacer") {
      currentSection = null;
    } else if (item.rowType === "item" || item.rowType === "cash") {
      const targetSection = item.rowType === "item" ? (item.sectionName ?? "") : "";
      if (!currentSection || currentSection.name !== targetSection) {
        currentSection = { name: targetSection, items: [] };
        sections.push(currentSection);
      }
      currentSection.items.push(item);
    }
  }

  const flagCount = shiftInventory.filter(i => i.isFlagged).length;

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
              {shift.boxAssignmentId && (
                <>
                  <span className="opacity-40">·</span>
                  <Boxes size={10} />
                  <span>{shift.boxAssignmentId.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</span>
                </>
              )}
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
          End Shift
        </Button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-4 divide-x divide-border/30 border-b border-border/30">
        <div className="px-4 py-3 text-center">
          <div className="text-lg font-bold">{shiftStats.orderCount}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Orders</div>
        </div>
        <div className="px-4 py-3 text-center">
          <div className="text-lg font-bold text-emerald-400">{fmtMoney(shiftStats.totalRevenue)}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Revenue</div>
        </div>
        <div className="px-4 py-3 text-center">
          <div className="text-lg font-bold text-emerald-400">{fmtMoney((shift.runningCashBank ?? 0))}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest flex items-center justify-center gap-0.5"><Banknote size={8} />Cash Bank</div>
        </div>
        <div className="px-4 py-3 text-center">
          <div className="text-lg font-bold">{shiftStats.byItem.reduce((s, i) => s + i.qtySold, 0)}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Units</div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-0 border-b border-border/30">
        {[
          { key: "overview" as const, label: "Items Sold", icon: BarChart3 },
          { key: "customers" as const, label: "By Customer", icon: Users },
          { key: "inventory" as const, label: "Inventory", icon: Boxes, badge: flagCount > 0 ? flagCount : 0 },
        ].map(({ key, label, icon: Icon, badge }) => (
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
            {badge != null && badge > 0 && (
              <span className="ml-0.5 w-4 h-4 flex items-center justify-center bg-red-500/20 text-red-400 rounded-full text-[9px] font-bold">
                {badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-[120px]">
        {tab === "overview" && (
          shiftStats.byItem.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">No items sold yet</div>
          ) : (
            <div className="divide-y divide-border/20">
              {shiftStats.byItem.map(item => (
                <div key={item.catalogItemId} className="flex justify-between items-center px-6 py-3 hover:bg-white/[0.02]">
                  <div className="text-sm font-medium">{item.name}</div>
                  <div className="flex items-center gap-4">
                    <div className="text-xs text-muted-foreground">{item.qtySold} units</div>
                    <div className="text-sm font-bold font-mono text-emerald-400">{fmtMoney(item.revenue)}</div>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === "customers" && (
          shiftStats.byCustomer.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">No customers served yet</div>
          ) : (
            <div className="divide-y divide-border/20">
              {shiftStats.byCustomer.map(c => (
                <div key={c.customerId} className="flex justify-between items-center px-6 py-3 hover:bg-white/[0.02]">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{c.name}</span>
                      <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] border ${c.paymentMethod === "card" ? "bg-blue-500/10 text-blue-400 border-blue-500/20" : c.paymentMethod === "comp" ? "bg-purple-500/10 text-purple-400 border-purple-500/20" : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"}`}>
                        {c.paymentMethod ?? "cash"}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">{c.orderCount} order{c.orderCount !== 1 ? "s" : ""}</div>
                  </div>
                  <div className="text-sm font-bold font-mono">{fmtMoney(c.total)}</div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === "inventory" && (
          shiftInventory.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">No inventory tracked</div>
          ) : (
            <div>
              <div className="grid grid-cols-[1fr_64px_64px_72px] gap-0 px-6 py-2 bg-muted/10 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest border-b border-border/20">
                <span>Item</span>
                <span className="text-right">Start</span>
                <span className="text-right">Sold</span>
                <span className="text-right">Left</span>
              </div>
              {sections.map((section, si) => (
                <div key={si}>
                  {section.name && (
                    <div className="px-6 py-1.5 bg-muted/15 text-[10px] font-bold text-muted-foreground uppercase tracking-widest border-b border-border/10">
                      {section.name}
                    </div>
                  )}
                  <div className="divide-y divide-border/15">
                    {section.items.map(item => {
                      const remaining = item.quantityEnd ?? (item.quantityStart - item.quantitySold);
                      const isLow = item.unitType !== "G" && remaining <= 3 && remaining > 0;
                      const isEmpty = remaining <= 0;
                      return (
                        <div key={item.id} className={`grid grid-cols-[1fr_64px_64px_72px] gap-0 px-6 py-3 hover:bg-white/[0.02] ${item.isFlagged ? "bg-red-500/5" : ""}`}>
                          <div className="text-sm font-medium truncate pr-2 flex items-center gap-1.5">
                            {item.isFlagged && <AlertTriangle size={11} className="text-red-400 shrink-0" />}
                            {item.itemName}
                          </div>
                          <div className="text-sm font-mono text-right text-muted-foreground">{fmtQty(item.quantityStart, item.unitType)}</div>
                          <div className="text-sm font-mono text-right text-orange-400">{fmtQty(item.quantitySold, item.unitType)}</div>
                          <div className={`text-sm font-bold font-mono text-right ${
                            item.isFlagged || isEmpty ? "text-red-400"
                              : isLow ? "text-orange-400"
                              : "text-emerald-400"
                          }`}>
                            {fmtQty(remaining, item.unitType)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ─── Fulfillment Card ─────────────────────────────────────────────────────────

const FULFILLMENT_STEPS = [
  { status: "accepted", label: "Claim", icon: HandshakeIcon, color: "yellow" },
  { status: "preparing", label: "Prepare", icon: Activity, color: "blue" },
  { status: "ready", label: "Ready", icon: DoorOpen, color: "emerald" },
  { status: "completed", label: "Complete", icon: CheckCircle2, color: "emerald" },
];

function getOrderLateState(order: ExtendedOrder): { label: string; stale: boolean } | null {
  if (!order.estimatedReadyAt) return null;
  const etaMs = new Date(order.estimatedReadyAt).getTime();
  if (Number.isNaN(etaMs)) return null;
  const lateMinutes = Math.floor((Date.now() - etaMs) / 60_000);
  if (lateMinutes <= 0) return null;
  if (lateMinutes > 24 * 60) return { label: "Stale Order", stale: true };
  return { label: `${lateMinutes}m late`, stale: false };
}

function FulfillmentCard({ order, onRefresh, getToken }: {
  order: ExtendedOrder;
  onRefresh: () => void;
  getToken: () => Promise<string | null>;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [printingReceipt, setPrintingReceipt] = useState(false);
  const [printingLabel, setPrintingLabel] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [checklist, setChecklist] = useState<Record<string, boolean>>(
    (order.handoffChecklist as Record<string, boolean> | null) ?? {}
  );
  const fulfillment = order.fulfillmentStatus as string | null;
  const safeItems = safeArray<ExtendedOrderItem>(order.items);

  async function toggleChecklistItem(key: string, value: boolean) {
    const next = { ...checklist, [key]: value };
    setChecklist(next);
    try {
      const token = await getToken();
      await fetch(`/api/orders/${order.id}/delivery/handoff-checklist`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [key]: value }),
      });
      onRefresh();
    } catch { /* non-critical */ }
  }

  async function markHandoffComplete() {
    setHandoffBusy(true);
    try {
      const token = await getToken();
      await fetch(`/api/orders/${order.id}/delivery/handoff-complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      onRefresh();
    } catch { /* non-critical */ } finally { setHandoffBusy(false); }
  }

  async function setFulfillmentStatus(status: string) {
    setLoading(status);
    try {
      const token = await getToken();
      const endpoint = status === "accepted"
        ? `/api/orders/${order.id}/claim`
        : status === "preparing"
        ? `/api/orders/${order.id}/prepare`
        : status === "ready"
        ? `/api/orders/${order.id}/ready`
        : `/api/orders/${order.id}/complete`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: status === "completed"
          ? { Authorization: `Bearer ${token}` }
          : { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        ...(status === "completed" ? {} : { body: JSON.stringify({ fulfillmentStatus: status }) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed with HTTP ${res.status}`);
      }
      onRefresh();
    } catch (err) {
      console.error("Fulfillment action failed", err);
    } finally { setLoading(null); }
  }

  async function printReceipt() {
    setPrintingReceipt(true);
    try {
      const token = await getToken();
      await fetch(`/api/print/orders/${order.id}/receipt`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* ignore fetch errors */ } finally { setPrintingReceipt(false); }
  }

  async function printLabel() {
    setPrintingLabel(true);
    try {
      const token = await getToken();
      await fetch(`/api/print/orders/${order.id}/label`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* ignore fetch errors */ } finally { setPrintingLabel(false); }
  }

  const activeStep = FULFILLMENT_STEPS.findIndex(s => s.status === fulfillment);
  const lateState = getOrderLateState(order);

  return (
    <div className="glass-card rounded-2xl border border-border/40 overflow-hidden" data-testid={`row-queue-${order.id}`}>
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
            {order.paymentMethod && (
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${order.paymentMethod === "card" ? "bg-blue-500/15 text-blue-400 border-blue-500/20" : order.paymentMethod === "comp" ? "bg-purple-500/15 text-purple-400 border-purple-500/20" : "bg-green-500/15 text-green-400 border-green-500/20"}`}>
                {order.paymentMethod.toUpperCase()}
              </span>
            )}
            {fulfillment && (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-primary/20 bg-primary/10 text-primary capitalize">
                {fulfillment.replace(/_/g, " ")}
              </span>
            )}
            {lateState && (
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${lateState.stale ? "bg-red-500/15 text-red-300 border-red-500/30" : "bg-amber-500/15 text-amber-300 border-amber-500/30"}`}>
                {lateState.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {new Date(order.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span>{safeItems.length} item{safeItems.length !== 1 ? "s" : ""}</span>
            <span className="font-mono font-bold text-foreground">
              ${order.total?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
            {order.deliveryMethod && order.deliveryMethod !== "pickup" && (
              <span className="flex items-center gap-1 text-primary">
                <Truck size={10} />
                {order.deliveryMethod === "uber_direct" ? "Uber Courier" : "Delivery"}
              </span>
            )}
          </div>
        </div>
        <button onClick={() => setExpanded(e => !e)} className="text-muted-foreground hover:text-foreground p-1">
          <ChevronRight size={16} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border/30 bg-muted/10 px-4 py-3 space-y-2">
          {order.deliveryMethod && order.deliveryMethod !== "pickup" && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs space-y-2" data-testid={`delivery-info-${order.id}`}>
              <div className="flex items-center gap-2 text-[10px] font-semibold text-primary uppercase tracking-widest">
                <Truck size={12} /> Delivery
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <div className="text-muted-foreground">Method</div>
                  <div className="font-mono font-semibold">{order.deliveryMethod === "uber_direct" ? "Uber Courier" : "Manual delivery"}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Fee</div>
                  <div className="font-mono font-semibold">{order.deliveryFee != null ? `$${order.deliveryFee.toFixed(2)}` : "—"}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">ETA</div>
                  <div className="font-mono font-semibold">
                    {formatCourierEta(order.deliveryQuote?.dropoffEta) ?? (order.deliveryQuote?.duration ? `${order.deliveryQuote.duration} min` : "—")}
                  </div>
                </div>
              </div>
              {order.shippingAddress && (
                <div className="pt-2 border-t border-primary/10 text-muted-foreground">
                  {order.shippingAddress}
                </div>
              )}
              {order.trackingUrl && (
                <div className="pt-2 border-t border-primary/10 space-y-2">
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle size={10} className="text-amber-400 shrink-0" />
                    <span className="text-[10px] font-bold text-amber-400 uppercase tracking-widest">Customer Tracking Link Received</span>
                  </div>
                  <a
                    href={order.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                    data-testid={`btn-open-tracking-${order.id}`}
                  >
                    <ExternalLink size={12} /> Open Uber Tracking
                  </a>
                  <div className="space-y-1 pt-1">
                    {([
                      { key: "driverMatched", label: "Driver name matched" },
                      { key: "vehicleMatched", label: "Vehicle matched" },
                      { key: "plateMatched", label: "License plate matched" },
                      { key: "sealedDiscreet", label: "Package sealed / discreet" },
                      { key: "handedToCourier", label: "Package handed to courier" },
                    ] as { key: string; label: string }[]).map(({ key, label }) => (
                      <label key={key} className="flex items-center gap-2 cursor-pointer text-xs select-none">
                        <input
                          type="checkbox"
                          checked={!!checklist[key]}
                          onChange={e => void toggleChecklistItem(key, e.target.checked)}
                          className="rounded accent-primary"
                          data-testid={`checklist-${key}-${order.id}`}
                        />
                        <span className={checklist[key] ? "line-through text-muted-foreground/60" : ""}>{label}</span>
                      </label>
                    ))}
                  </div>
                  {order.handoffCompletedAt ? (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                      <CheckCircle2 size={12} />
                      Handed off {new Date(order.handoffCompletedAt as string).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      className="w-full h-7 text-xs rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/30"
                      disabled={handoffBusy}
                      onClick={() => void markHandoffComplete()}
                      data-testid={`btn-handoff-complete-${order.id}`}
                    >
                      <CheckCircle2 size={11} className="mr-1.5" />
                      {handoffBusy ? "Marking..." : "Mark Handoff Complete"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">Line Items</div>
          {safeItems.map((item, i) => (
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

      <div className="border-t border-border/30 px-4 py-2.5 flex items-center gap-2">
        <Button size="sm" variant="outline" className="gap-1.5 text-xs h-7 rounded-lg border-border/50" onClick={printReceipt} disabled={printingReceipt}>
          {printingReceipt ? <RefreshCw size={11} className="animate-spin" /> : <Printer size={11} />}
          Receipt
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5 text-xs h-7 rounded-lg border-border/50" onClick={printLabel} disabled={printingLabel}>
          {printingLabel ? <RefreshCw size={11} className="animate-spin" /> : <Printer size={11} />}
          Label
        </Button>
        <Link href={`/orders/${order.id}`} className="ml-auto text-[11px] text-muted-foreground hover:text-foreground transition-colors">
          View Detail →
        </Link>
      </div>

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

// ─── Main page ────────────────────────────────────────────────────────────────

function CustomerServiceRepQueueContent() {
  const [activeTab, setActiveTab] = useState("pending");
  const [summaryData, setSummaryData] = useState<SummaryData | null>(null);
  const [queueData, setQueueData] = useState<{ orders: ExtendedOrder[]; total: number }>({ orders: [], total: 0 });
  const [isLoadingQueue, setIsLoadingQueue] = useState(false);
  const [showClockOutModal, setShowClockOutModal] = useState(false);
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });

  const { shift, setShift, loading: shiftLoading, refetch: refetchShift } = useShift(getToken);

  const userRole = normalizeUiRole(user?.role);
  const isAdmin = userRole === "admin" || userRole === "global_admin";
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);

  const fetchQueue = useCallback(async () => {
    setIsLoadingQueue(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/shift-queue/orders", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) { setQueueData({ orders: [], total: 0 }); return; }
      const json = await res.json() as { orders?: ExtendedOrder[]; total?: number };
      const safeOrders = safeArray<ExtendedOrder>(json.orders);
      setQueueData({ orders: safeOrders, total: json.total ?? 0 });
    } finally {
      setIsLoadingQueue(false);
    }
  }, [getToken]);

  const safeOrders = safeArray<ExtendedOrder>(queueData.orders);
  const visibleOrders = safeOrders.filter(order => order.status === activeTab || order.fulfillmentStatus === activeTab);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["shiftQueueOrders"] });
    void fetchQueue();
    refetchShift();
  }, [fetchQueue, queryClient, refetchShift]);

  useOrderEvents(() => {
    refresh();
  }, Boolean(shift));

  useEffect(() => {
    void fetchQueue();
  }, [fetchQueue, shift]);

  useEffect(() => {
    if (!shift) return;
    const timer = setInterval(() => { refetchShift(); void fetchQueue(); }, 30_000);
    return () => clearInterval(timer);
  }, [shift, refetchShift, fetchQueue]);

  const handleClockIn = async (snapshot: InventorySnapshot[], cashBankStart: number, setup: ShiftSetup) => {
    const token = await getToken();
    const method = "POST";
    const endpoint = "/api/shifts/clock-in";
    const res = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        inventorySnapshot: snapshot,
        cashBankStart,
        boxAssignmentId: setup.boxAssignmentId,
        setup: {
          shiftLocationId: setup.shiftLocationId,
          deliveryOptionId: setup.deliveryOptionId,
          wifiReady: setup.wifiReady,
          printerReady: setup.printerReady,
          locationReady: setup.locationReady,
          csrDeliveryOptIn: setup.csrDeliveryOptIn ?? false,
          wifiSsid: setup.wifiSsid ?? "",
          pickupNote: setup.pickupNote ?? "",
        },
      }),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const responseData = contentType.includes("application/json") ? (await res.json() as Record<string, unknown>) : null;
    if (isAdmin && !res.ok) {
      setDebugEntries(prev => [{
        label: "Clock-in (failed)",
        method,
        endpoint,
        status: res.status,
        response: responseData,
        timestamp: new Date().toLocaleTimeString(),
      }, ...prev]);
    }
    if (!res.ok) {
      if (res.status === 403) {
        throw new Error("Access denied — ask an admin to confirm this account is active and has a CSR alias such as Customer Service Rep/CSR/QSR.");
      }
      const msg = responseData
        ? ((responseData as { error?: string }).error ?? "Clock-in failed")
        : `Clock-in failed (${res.status})`;
      throw new Error(msg);
    }

    // POST /api/shifts/clock-in is intentionally idempotent. If the CSR is
    // already active, the server returns 200 with { alreadyClockedIn: true,
    // shift }. Treat that as a usable POS state instead of surfacing the raw
    // JSON/debug response as an error.
    if (responseData?.shift) {
      setShift(normalizeActiveShift(responseData.shift as RawShift));
    }
    await refetchShift();
  };

  const handleClockOutConfirm = async (data: {
    endingInventory: { shiftInventoryItemId: number; quantityEndActual: number }[];
    cashBankEnd: number;
  }) => {
    const token = await getToken();
    const res = await fetch("/api/shifts/clock-out", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      const resData = await res.json();
      setShift(null);
      setShowClockOutModal(false);
      setSummaryData(normalizeSummaryData(resData.summary));
    }
  };

  // All roles that can clock in — must match SHIFT_OPERATOR_ROLES in shifts.ts
  const isStaff = userRole === "csr" || userRole === "admin" || userRole === "global_admin";
  // Spec: CSR alert banner + Accept controls are CSR-only. Supervisors/admins
  // get the supervisor surfaces (delayed list, reassign panel) instead.
  const isCsrOnly = userRole === "csr";

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-title">
            Shift Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-subtitle">
            Start shift, manage inventory, track cash bank &amp; orders
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl" onClick={refresh} title="Refresh">
          <RefreshCw size={16} />
        </Button>
      </div>

      {/* Task #12: realtime CSR alert banner — CSR roles only */}
      {isCsrOnly && user?.id != null && (
        <CsrAlertBanner currentUserId={user.id} onAccepted={refresh} />
      )}

      {/* Shift panel */}
      {isStaff && (
        shiftLoading ? (
          <div className="h-24 animate-pulse bg-muted/20 rounded-2xl" />
        ) : shift ? (
          <ActiveShiftPanel shift={shift} onClockOut={() => setShowClockOutModal(true)} />
        ) : (
          <ClockInPanel onClockIn={handleClockIn} getToken={getToken} />
        )
      )}

      {/* Admin debug panel — clock-in/out calls */}
      {isAdmin && debugEntries.length > 0 && (
        <DebugPanel entries={debugEntries} onClear={() => setDebugEntries([])} />
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

        {isLoadingQueue ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse bg-muted/20 rounded-2xl" />
            ))}
          </div>
        ) : visibleOrders.length === 0 ? (
          <div className="glass-card rounded-2xl flex flex-col items-center justify-center py-20 text-center">
            <div className="w-14 h-14 rounded-2xl bg-muted/20 flex items-center justify-center mb-4">
              <Package size={24} className="text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-sm mb-1">Queue is clear</h3>
            <p className="text-xs text-muted-foreground">No {activeTab} orders right now.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {visibleOrders.map((order) => (
              <FulfillmentCard
                key={order.id}
                order={order as ExtendedOrder}
                onRefresh={refresh}
                getToken={getToken}
              />
            ))}
          </div>
        )}
      </div>

      {/* Clock-out modal — collects ending inventory + cash */}
      {showClockOutModal && shift && (
        <ClockOutModal
          shift={shift}
          onConfirm={handleClockOutConfirm}
          onCancel={() => setShowClockOutModal(false)}
        />
      )}

      {/* End-of-shift summary modal */}
      {summaryData && (
        <ShiftSummaryModal summary={summaryData} onClose={() => setSummaryData(null)} />
      )}
    </div>
  );
}


export default function CustomerServiceRepQueue() {
  return (
    <StaffErrorBoundary>
      <CustomerServiceRepQueueContent />
    </StaffErrorBoundary>
  );
}
