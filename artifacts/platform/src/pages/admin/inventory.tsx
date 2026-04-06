import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@clerk/react";
import { Save, ClipboardList, DollarSign, RefreshCw, ChevronRight, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type InvItem = {
  id: number;
  name: string;
  alavontName: string | null;
  luciferCruzName: string | null;
  category: string;
  price: string;
  stockQuantity: number | null;
  stockUnit: string;
  isAvailable: boolean;
};

type RowState = {
  starting: string;
  ending: string;
  unit: string;
  dirty: boolean;
  saving: boolean;
};

const PHARMACY_CATEGORIES = ["Pharmacy"];
const EXCLUDE_CATEGORIES = ["Membership", "Self Care & Ambiance", "Lubricants & Enhancers", "Kink & Fetish"];

function categoryOrder(cat: string): number {
  const order: Record<string, number> = {
    "Psychedelics & Hallucinogens": 1,
    "Stimulants": 2,
    "Depressants & Precursors": 3,
    "Dissociative's": 4,
    "Dissociatives": 4,
    "Accessories": 5,
    "Pharmacy": 6,
  };
  return order[cat] ?? 99;
}

function fmt(val: string): string {
  const n = parseFloat(val);
  if (isNaN(n) || val.trim() === "") return "";
  return n % 1 === 0 ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function diff(starting: string, ending: string): string {
  const s = parseFloat(starting);
  const e = parseFloat(ending);
  if (isNaN(s) || isNaN(e)) return "";
  const d = s - e;
  return d % 1 === 0 ? String(d) : d.toFixed(2);
}

export default function AdminInventory() {
  const { getToken } = useAuth();
  const [items, setItems] = useState<InvItem[]>([]);
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [pettyCash, setPettyCash] = useState<string>("0.00");
  const [pettyCashDirty, setPettyCashDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date] = useState(() => new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }));
  const saveQueue = useRef<Set<number>>(new Set());

  const fetchInventory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/inventory", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load inventory");
      const data = await res.json();
      setItems(data.items);
      setPettyCash(parseFloat(data.pettyCash ?? 0).toFixed(2));
      const initial: Record<number, RowState> = {};
      for (const item of data.items) {
        initial[item.id] = {
          starting: item.stockQuantity != null ? String(item.stockQuantity) : "",
          ending: "",
          unit: item.stockUnit ?? "#",
          dirty: false,
          saving: false,
        };
      }
      setRows(initial);
    } catch (e: any) {
      setError(e?.message ?? "Network error");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { fetchInventory(); }, [fetchInventory]);

  function updateRow(id: number, field: keyof Omit<RowState, "dirty" | "saving">, val: string) {
    setRows(prev => ({ ...prev, [id]: { ...prev[id], [field]: val, dirty: true } }));
  }

  async function saveRow(id: number) {
    const row = rows[id];
    if (!row?.dirty) return;
    setRows(prev => ({ ...prev, [id]: { ...prev[id], saving: true } }));
    try {
      const token = await getToken();
      await fetch(`/api/admin/inventory/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          stockQuantity: row.starting.trim() === "" ? null : parseFloat(row.starting),
          stockUnit: row.unit,
        }),
      });
      setRows(prev => ({ ...prev, [id]: { ...prev[id], dirty: false, saving: false } }));
    } catch {
      setRows(prev => ({ ...prev, [id]: { ...prev[id], saving: false } }));
    }
  }

  async function saveAll() {
    setSaving(true);
    const token = await getToken();
    const dirtyIds = Object.entries(rows)
      .filter(([, r]) => r.dirty)
      .map(([id]) => parseInt(id));
    await Promise.all(dirtyIds.map(id => {
      const row = rows[id];
      return fetch(`/api/admin/inventory/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          stockQuantity: row.starting.trim() === "" ? null : parseFloat(row.starting),
          stockUnit: row.unit,
        }),
      });
    }));
    if (pettyCashDirty) {
      await fetch("/api/admin/inventory/petty-cash", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pettyCash: parseFloat(pettyCash) || 0 }),
      });
      setPettyCashDirty(false);
    }
    setRows(prev => {
      const next = { ...prev };
      for (const id of dirtyIds) next[id] = { ...next[id], dirty: false };
      return next;
    });
    setSaving(false);
  }

  // Group items by category, sorted, excluding certain categories
  const visibleItems = items.filter(it => !EXCLUDE_CATEGORIES.includes(it.category));
  const byCategory: Record<string, InvItem[]> = {};
  for (const item of visibleItems) {
    const cat = item.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(item);
  }
  const sortedCats = Object.keys(byCategory).sort((a, b) => categoryOrder(a) - categoryOrder(b));

  // Group items within a category by name
  function byName(items: InvItem[]): Record<string, InvItem[]> {
    const g: Record<string, InvItem[]> = {};
    for (const item of items) {
      const key = item.name;
      if (!g[key]) g[key] = [];
      g[key].push(item);
    }
    return g;
  }

  const dirtyCount = Object.values(rows).filter(r => r.dirty).length;
  const isPharmacySection = (cat: string) => PHARMACY_CATEGORIES.includes(cat);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-6 flex items-center justify-center h-64">
        <RefreshCw size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 p-4 text-sm">{error}</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <ClipboardList size={18} className="text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Inventory</h1>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
              <Calendar size={11} />
              {date}
            </div>
          </div>
        </div>
        <Button
          onClick={saveAll}
          disabled={saving || (dirtyCount === 0 && !pettyCashDirty)}
          className="gap-2 rounded-xl"
          size="sm"
        >
          {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
          {saving ? "Saving..." : dirtyCount > 0 || pettyCashDirty ? `Save Changes (${dirtyCount + (pettyCashDirty ? 1 : 0)})` : "All Saved"}
        </Button>
      </div>

      {/* Column header */}
      <div className="grid grid-cols-[1fr_80px_100px_100px_100px_90px] gap-2 px-3 text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
        <div>Item</div>
        <div className="text-center">Unit</div>
        <div className="text-center">Starting</div>
        <div className="text-center">Ending</div>
        <div className="text-center">Difference</div>
        <div className="text-center">Discrepancy</div>
      </div>

      {/* Items by category */}
      {sortedCats.map(cat => {
        const catItems = byCategory[cat];
        const nameGroups = byName(catItems);
        const names = Object.keys(nameGroups);
        const isPharm = isPharmacySection(cat);

        return (
          <div key={cat} className="space-y-1">
            {/* Pharmacy gets a special header box */}
            {isPharm ? (
              <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-center font-bold text-sm tracking-wider text-primary mb-3">
                Pharmacy
              </div>
            ) : null}

            {names.map(name => {
              const groupItems = nameGroups[name];
              const isGroup = groupItems.length > 1;

              return (
                <div key={name} className="rounded-xl border border-border/40 bg-card/30 overflow-hidden">
                  {/* Product group header */}
                  <div className="px-3 py-2 bg-muted/20 border-b border-border/30 flex items-center gap-2">
                    {isGroup && <ChevronRight size={12} className="text-muted-foreground/50" />}
                    <span className="text-sm font-semibold">{name}</span>
                    <Badge variant="outline" className="text-[10px] ml-auto">{cat.replace("Psychedelics & Hallucinogens", "Psychedelics").replace("Depressants & Precursors", "Depressants").replace("Dissociative's", "Dissociatives")}</Badge>
                  </div>

                  {/* Rows */}
                  {groupItems.map((item, idx) => {
                    const row = rows[item.id];
                    if (!row) return null;
                    const diffVal = diff(row.starting, row.ending);

                    // Sub-label for grouped items
                    const subLabel = isGroup ? (
                      item.price ? `$${parseFloat(item.price).toFixed(0)}` : `#${idx + 1}`
                    ) : null;

                    return (
                      <div
                        key={item.id}
                        className={`grid grid-cols-[1fr_80px_100px_100px_100px_90px] gap-2 px-3 py-2 items-center border-b border-border/20 last:border-0 transition-colors ${row.dirty ? "bg-primary/[0.03]" : "hover:bg-muted/10"}`}
                      >
                        {/* Name */}
                        <div className="text-xs text-muted-foreground truncate">
                          {subLabel ? (
                            <span className="font-mono text-[11px] bg-muted/40 rounded px-1.5 py-0.5 mr-2">{subLabel}</span>
                          ) : null}
                          {isGroup ? "" : <span className="text-foreground/70">{item.luciferCruzName || item.name}</span>}
                          {row.dirty && <span className="ml-1.5 text-[10px] text-primary font-medium">•</span>}
                        </div>

                        {/* Unit toggle */}
                        <div className="flex justify-center">
                          <button
                            onClick={() => updateRow(item.id, "unit", row.unit === "G" ? "#" : "G")}
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-full border transition-all ${row.unit === "G" ? "border-amber-500/40 bg-amber-500/10 text-amber-400" : "border-border/50 bg-muted/30 text-muted-foreground"}`}
                          >
                            {row.unit}
                          </button>
                        </div>

                        {/* Starting */}
                        <div>
                          <Input
                            value={row.starting}
                            onChange={e => updateRow(item.id, "starting", e.target.value)}
                            onBlur={() => saveRow(item.id)}
                            placeholder="—"
                            className="h-7 text-xs text-center rounded-lg bg-background/60 border-border/40 font-mono"
                          />
                        </div>

                        {/* Ending */}
                        <div>
                          <Input
                            value={row.ending}
                            onChange={e => updateRow(item.id, "ending", e.target.value)}
                            placeholder="—"
                            className="h-7 text-xs text-center rounded-lg bg-background/60 border-border/40 font-mono"
                          />
                        </div>

                        {/* Difference */}
                        <div className="text-center">
                          {diffVal !== "" ? (
                            <span className={`text-xs font-mono font-semibold ${parseFloat(diffVal) < 0 ? "text-red-400" : parseFloat(diffVal) > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                              {diffVal}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/30 text-xs">—</span>
                          )}
                        </div>

                        {/* Discrepancy */}
                        <div className="text-center">
                          <span className="text-muted-foreground/30 text-xs">0</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* Petty Cash */}
      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
        <div className="px-5 py-4 border-b border-amber-500/10 flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <DollarSign size={15} className="text-amber-400" />
          </div>
          <span className="font-bold text-sm text-amber-300">Petty Cash</span>
        </div>
        <div className="px-5 py-5 flex items-center gap-4">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-amber-400 font-bold text-sm">$</span>
            <Input
              value={pettyCash}
              onChange={e => { setPettyCash(e.target.value); setPettyCashDirty(true); }}
              onBlur={() => {
                const n = parseFloat(pettyCash);
                if (!isNaN(n)) setPettyCash(n.toFixed(2));
              }}
              className="pl-7 w-40 h-10 text-2xl font-bold text-amber-300 bg-transparent border-amber-500/20 rounded-xl"
            />
          </div>
          {pettyCashDirty && (
            <span className="text-xs text-amber-400/70 font-medium">Unsaved</span>
          )}
        </div>
      </div>

      {/* Summary save reminder */}
      {(dirtyCount > 0 || pettyCashDirty) && (
        <div className="flex items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {dirtyCount} item{dirtyCount !== 1 ? "s" : ""} with unsaved changes
          </span>
          <Button onClick={saveAll} disabled={saving} size="sm" className="gap-2 rounded-xl h-7">
            {saving ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
            Save All
          </Button>
        </div>
      )}
    </div>
  );
}
