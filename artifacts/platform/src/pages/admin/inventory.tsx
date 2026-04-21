import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@clerk/react";
import {
  Save, ClipboardList, DollarSign, RefreshCw, ChevronRight, Calendar,
  Settings2, Eye, EyeOff, Loader2, Plus, Trash2, RotateCcw, Link2, Database,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

// ─── Stock Levels Types ───────────────────────────────────────────────────────

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

// ─── Shift Template Types ─────────────────────────────────────────────────────

type CatalogOption = {
  id: number;
  label: string;
  category: string;
};

type TemplateRow = {
  id: number;
  sectionName: string | null;
  itemName: string | null;
  rowType: string;
  unitType: string;
  startingQuantityDefault: string;
  currentStock: string | null;
  displayOrder: number;
  isActive: boolean;
  catalogItemId: number | null;
  deductionQuantityPerSale: string;
};

type TemplateRowEdit = {
  itemName: string;
  unitType: string;
  startingQuantityDefault: string;
  currentStock: string;
  isActive: boolean;
  catalogItemId: number | null;
  deductionQty: string;
  dirty: boolean;
  saving: boolean;
};

// ─── Constants ────────────────────────────────────────────────────────────────

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

function diff(starting: string, ending: string): string {
  const s = parseFloat(starting);
  const e = parseFloat(ending);
  if (isNaN(s) || isNaN(e)) return "";
  const d = s - e;
  return d % 1 === 0 ? String(d) : d.toFixed(2);
}

// ─── Shift Template Tab ───────────────────────────────────────────────────────

function ShiftTemplateTab({ getToken }: { getToken: () => Promise<string | null> }) {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [edits, setEdits] = useState<Record<number, TemplateRowEdit>>({});
  const [catalogOptions, setCatalogOptions] = useState<CatalogOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<{ inserted: number; updated: number } | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const headers = { Authorization: `Bearer ${token}` };

      const [tmplRes, catRes] = await Promise.all([
        fetch("/api/admin/inventory-template", { headers }),
        fetch("/api/admin/inventory", { headers }),
      ]);

      if (!tmplRes.ok) throw new Error("Failed to load template");
      const tmplData = await tmplRes.json();
      const fetched: TemplateRow[] = tmplData.template;
      setRows(fetched);

      const init: Record<number, TemplateRowEdit> = {};
      for (const r of fetched) {
        init[r.id] = {
          itemName: r.itemName ?? "",
          unitType: r.unitType,
          startingQuantityDefault: String(parseFloat(String(r.startingQuantityDefault)) || 0),
          currentStock: r.currentStock != null ? String(parseFloat(String(r.currentStock))) : "",
          isActive: r.isActive,
          catalogItemId: r.catalogItemId ?? null,
          deductionQty: String(parseFloat(String(r.deductionQuantityPerSale)) || 1),
          dirty: false,
          saving: false,
        };
      }
      setEdits(init);

      if (catRes.ok) {
        const catData = await catRes.json();
        const opts: CatalogOption[] = (catData.items ?? []).map((it: InvItem) => ({
          id: it.id,
          label: it.alavontName || it.luciferCruzName || it.name,
          category: it.category,
        }));
        opts.sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category) || a.label.localeCompare(b.label));
        setCatalogOptions(opts);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  function update(id: number, field: keyof Omit<TemplateRowEdit, "dirty" | "saving">, val: string | boolean | number | null) {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], [field]: val, dirty: true } }));
  }

  async function saveRow(id: number) {
    const edit = edits[id];
    if (!edit?.dirty) return;
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], saving: true } }));
    try {
      const token = await getToken();
      await fetch(`/api/admin/inventory-template/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          itemName: edit.itemName,
          unitType: edit.unitType,
          startingQuantityDefault: parseFloat(edit.startingQuantityDefault) || 0,
          currentStock: edit.currentStock.trim() === "" ? null : parseFloat(edit.currentStock),
          isActive: edit.isActive,
          catalogItemId: edit.catalogItemId ?? null,
          deductionQuantityPerSale: parseFloat(edit.deductionQty) || 1,
        }),
      });
      setEdits(prev => ({ ...prev, [id]: { ...prev[id], dirty: false, saving: false } }));
    } catch {
      setEdits(prev => ({ ...prev, [id]: { ...prev[id], saving: false } }));
    }
  }

  async function resetCurrentStock(id: number) {
    const edit = edits[id];
    if (!edit) return;
    const defaultVal = edit.startingQuantityDefault;
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], currentStock: defaultVal, dirty: true } }));
    const token = await getToken();
    await fetch(`/api/admin/inventory-template/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentStock: parseFloat(defaultVal) || 0 }),
    });
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], dirty: false } }));
  }

  async function addRow() {
    setAdding(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/inventory-template", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          itemName: "New Item",
          rowType: "item",
          unitType: "#",
          startingQuantityDefault: 0,
          displayOrder: 9999,
        }),
      });
      if (!res.ok) throw new Error("Failed to create");
      const data = await res.json();
      const r: TemplateRow = data.item;
      setRows(prev => [...prev, r]);
      setEdits(prev => ({
        ...prev,
        [r.id]: {
          itemName: r.itemName ?? "",
          unitType: r.unitType,
          startingQuantityDefault: "0",
          currentStock: "0",
          isActive: r.isActive,
          catalogItemId: null,
          deductionQty: "1",
          dirty: false,
          saving: false,
        },
      }));
    } catch { /* silent */ } finally {
      setAdding(false);
    }
  }

  async function seedFromCsv() {
    setSeeding(true);
    setSeedResult(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/inventory-template/seed", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Seed failed");
      setSeedResult({ inserted: data.inserted, updated: data.updated });
      await fetchAll();
      setTimeout(() => setSeedResult(null), 5000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Seed failed");
    } finally {
      setSeeding(false);
    }
  }

  async function deleteRow(id: number) {
    if (!confirm("Delete this inventory item?")) return;
    const token = await getToken();
    await fetch(`/api/admin/inventory-template/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    setRows(prev => prev.filter(r => r.id !== id));
    setEdits(prev => { const next = { ...prev }; delete next[id]; return next; });
  }

  async function saveAll() {
    setSavingAll(true);
    const dirtyIds = Object.entries(edits)
      .filter(([, e]) => e.dirty)
      .map(([id]) => parseInt(id));
    await Promise.all(dirtyIds.map(saveRow));
    setSavingAll(false);
  }

  const dirtyCount = Object.values(edits).filter(e => e.dirty).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 p-4 text-sm">{error}</div>
    );
  }

  // Group rows by section
  const sections: { name: string; rows: TemplateRow[] }[] = [];
  let currentSection: { name: string; rows: TemplateRow[] } | null = null;
  for (const row of rows) {
    if (row.rowType === "section") {
      currentSection = { name: row.sectionName ?? row.itemName ?? "", rows: [] };
      sections.push(currentSection);
    } else if (row.rowType === "spacer") {
      currentSection = null;
    } else if (row.rowType === "item" || row.rowType === "cash") {
      if (!currentSection) {
        currentSection = { name: "", rows: [] };
        sections.push(currentSection);
      }
      currentSection.rows.push(row);
    }
  }

  const colHeader = "grid grid-cols-[1fr_50px_88px_100px_180px_76px_44px_32px] gap-2 px-3 text-[10px] font-bold text-muted-foreground uppercase tracking-widest";
  const colRow = "grid grid-cols-[1fr_50px_88px_100px_180px_76px_44px_32px] gap-2 px-3 py-2 items-center transition-colors";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Raw Material Inventory</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Current stock auto-deducts when linked menu items are fulfilled. Managers can add, edit, or delete items.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={seedFromCsv}
            disabled={seeding}
            size="sm"
            variant="outline"
            className="gap-1.5 rounded-xl border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
            title="Load all 26 products from the Alavont CSR cash box spreadsheet"
          >
            {seeding ? <Loader2 size={12} className="animate-spin" /> : <Database size={12} />}
            {seeding ? "Seeding..." : "Seed from CSV"}
          </Button>
          <Button
            onClick={addRow}
            disabled={adding}
            size="sm"
            variant="outline"
            className="gap-1.5 rounded-xl"
          >
            {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Add Item
          </Button>
          <Button
            onClick={saveAll}
            disabled={savingAll || dirtyCount === 0}
            size="sm"
            className="gap-2 rounded-xl"
          >
            {savingAll ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
            {dirtyCount > 0 ? `Save ${dirtyCount}` : "Saved"}
          </Button>
        </div>
      </div>

      {/* Seed result banner */}
      {seedResult && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 text-green-400 px-4 py-2.5 text-xs flex items-center gap-2">
          <Database size={13} />
          Seeded successfully — <strong>{seedResult.inserted}</strong> items added, <strong>{seedResult.updated}</strong> items updated with prices.
        </div>
      )}

      {/* Column header */}
      <div className={colHeader}>
        <div>Item Label</div>
        <div className="text-center">Unit</div>
        <div className="text-center">Default</div>
        <div className="text-center">Current Stock</div>
        <div>Linked Menu Item</div>
        <div className="text-center">Deduct/Sale</div>
        <div className="text-center">Active</div>
        <div />
      </div>

      {sections.map((section, si) => (
        <div key={si} className="rounded-xl border border-border/40 bg-card/30 overflow-hidden">
          {section.name && (
            <div className="px-4 py-2.5 bg-muted/20 border-b border-border/30">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{section.name}</span>
            </div>
          )}
          <div className="divide-y divide-border/20">
            {section.rows.map(row => {
              const edit = edits[row.id];
              if (!edit) return null;
              const linkedLabel = edit.catalogItemId
                ? catalogOptions.find(o => o.id === edit.catalogItemId)?.label ?? `#${edit.catalogItemId}`
                : null;
              const stockNum = parseFloat(edit.currentStock);
              const defaultNum = parseFloat(edit.startingQuantityDefault);
              const stockLow = !isNaN(stockNum) && !isNaN(defaultNum) && stockNum < defaultNum * 0.25;
              return (
                <div
                  key={row.id}
                  className={`${colRow} ${edit.dirty ? "bg-primary/[0.03]" : "hover:bg-muted/10"} ${!edit.isActive ? "opacity-50" : ""}`}
                >
                  {/* Label */}
                  <div className="flex items-center gap-1">
                    <Input
                      value={edit.itemName}
                      onChange={e => update(row.id, "itemName", e.target.value)}
                      onBlur={() => saveRow(row.id)}
                      className="h-7 text-xs rounded-lg bg-background/60 border-border/40"
                    />
                    {edit.saving && <Loader2 size={11} className="animate-spin text-muted-foreground shrink-0" />}
                    {!edit.saving && edit.dirty && <span className="text-[10px] text-primary shrink-0">•</span>}
                  </div>

                  {/* Unit toggle */}
                  <div className="flex justify-center">
                    <button
                      onClick={() => {
                        update(row.id, "unitType", edit.unitType === "G" ? "#" : "G");
                        setTimeout(() => saveRow(row.id), 50);
                      }}
                      className={`text-[11px] font-bold px-2 py-0.5 rounded-full border transition-all ${
                        edit.unitType === "G"
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                          : "border-border/50 bg-muted/30 text-muted-foreground"
                      }`}
                    >
                      {edit.unitType}
                    </button>
                  </div>

                  {/* Default qty */}
                  <Input
                    type="number"
                    min="0"
                    step={edit.unitType === "G" ? "0.1" : "1"}
                    value={edit.startingQuantityDefault}
                    onChange={e => update(row.id, "startingQuantityDefault", e.target.value)}
                    onBlur={() => saveRow(row.id)}
                    className="h-7 text-xs text-center rounded-lg bg-background/60 border-border/40 font-mono"
                  />

                  {/* Current Stock */}
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min="0"
                      step={edit.unitType === "G" ? "0.1" : "1"}
                      value={edit.currentStock}
                      onChange={e => update(row.id, "currentStock", e.target.value)}
                      onBlur={() => saveRow(row.id)}
                      className={`h-7 text-xs text-center rounded-lg border font-mono font-semibold flex-1 ${
                        stockLow
                          ? "border-red-500/40 bg-red-500/5 text-red-400"
                          : "bg-background/60 border-border/40"
                      }`}
                    />
                    <button
                      onClick={() => resetCurrentStock(row.id)}
                      title="Reset to default"
                      className="text-muted-foreground/50 hover:text-muted-foreground transition-colors shrink-0"
                    >
                      <RotateCcw size={11} />
                    </button>
                  </div>

                  {/* Linked Menu Item */}
                  <div className="relative">
                    <select
                      value={edit.catalogItemId ?? ""}
                      onChange={e => {
                        const val = e.target.value;
                        update(row.id, "catalogItemId", val === "" ? null : parseInt(val));
                        setTimeout(() => saveRow(row.id), 50);
                      }}
                      className="w-full h-7 text-[11px] rounded-lg bg-background/60 border border-border/40 px-2 text-foreground appearance-none pr-6 truncate"
                    >
                      <option value="">— None —</option>
                      {catalogOptions.map(opt => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                      ))}
                    </select>
                    {linkedLabel && (
                      <Link2 size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-primary/60 pointer-events-none" />
                    )}
                  </div>

                  {/* Deduct per sale */}
                  <Input
                    type="number"
                    min="0"
                    step="0.1"
                    value={edit.deductionQty}
                    onChange={e => update(row.id, "deductionQty", e.target.value)}
                    onBlur={() => saveRow(row.id)}
                    disabled={!edit.catalogItemId}
                    title="How much to deduct from current stock each time the linked menu item is sold"
                    className={`h-7 text-xs text-center rounded-lg bg-background/60 border-border/40 font-mono ${!edit.catalogItemId ? "opacity-30" : ""}`}
                  />

                  {/* Active toggle */}
                  <div className="flex justify-center">
                    <button
                      onClick={() => {
                        update(row.id, "isActive", !edit.isActive);
                        setTimeout(() => saveRow(row.id), 50);
                      }}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      title={edit.isActive ? "Disable" : "Enable"}
                    >
                      {edit.isActive ? <Eye size={13} /> : <EyeOff size={13} />}
                    </button>
                  </div>

                  {/* Delete */}
                  <div className="flex justify-center">
                    <button
                      onClick={() => deleteRow(row.id)}
                      className="text-muted-foreground/40 hover:text-red-400 transition-colors"
                      title="Delete item"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}

            {section.rows.length === 0 && (
              <div className="px-4 py-4 text-center text-xs text-muted-foreground/40">No items in this section</div>
            )}
          </div>
        </div>
      ))}

      {rows.filter(r => r.rowType === "item" || r.rowType === "cash").length === 0 && (
        <div className="rounded-xl border border-dashed border-border/40 p-8 text-center text-xs text-muted-foreground">
          No inventory items yet. Click <strong>Add Item</strong> to get started.
        </div>
      )}

      {dirtyCount > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
          <span className="text-xs text-muted-foreground">{dirtyCount} unsaved change{dirtyCount !== 1 ? "s" : ""}</span>
          <Button onClick={saveAll} disabled={savingAll} size="sm" className="gap-2 rounded-xl h-7">
            {savingAll ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
            Save All
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Stock Levels Tab ─────────────────────────────────────────────────────────

function StockLevelsTab({ getToken }: { getToken: () => Promise<string | null> }) {
  const [items, setItems] = useState<InvItem[]>([]);
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [pettyCash, setPettyCash] = useState<string>("0.00");
  const [pettyCashDirty, setPettyCashDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date] = useState(() => new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }));

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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
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
    const dirtyIds = Object.entries(rows).filter(([, r]) => r.dirty).map(([id]) => parseInt(id));
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

  const visibleItems = items.filter(it => !EXCLUDE_CATEGORIES.includes(it.category));
  const byCategory: Record<string, InvItem[]> = {};
  for (const item of visibleItems) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }
  const sortedCats = Object.keys(byCategory).sort((a, b) => categoryOrder(a) - categoryOrder(b));

  function byName(items: InvItem[]): Record<string, InvItem[]> {
    const g: Record<string, InvItem[]> = {};
    for (const item of items) {
      if (!g[item.name]) g[item.name] = [];
      g[item.name].push(item);
    }
    return g;
  }

  const dirtyCount = Object.values(rows).filter(r => r.dirty).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 p-4 text-sm">{error}</div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Calendar size={11} />
          {date}
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

      {sortedCats.map(cat => {
        const catItems = byCategory[cat];
        const nameGroups = byName(catItems);
        const names = Object.keys(nameGroups);
        const isPharm = PHARMACY_CATEGORIES.includes(cat);

        return (
          <div key={cat} className="space-y-1">
            {isPharm && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-center font-bold text-sm tracking-wider text-primary mb-3">
                Pharmacy
              </div>
            )}
            {names.map(name => {
              const groupItems = nameGroups[name];
              const isGroup = groupItems.length > 1;
              return (
                <div key={name} className="rounded-xl border border-border/40 bg-card/30 overflow-hidden">
                  <div className="px-3 py-2 bg-muted/20 border-b border-border/30 flex items-center gap-2">
                    {isGroup && <ChevronRight size={12} className="text-muted-foreground/50" />}
                    <span className="text-sm font-semibold">{name}</span>
                    <Badge variant="outline" className="text-[10px] ml-auto">
                      {cat.replace("Psychedelics & Hallucinogens", "Psychedelics").replace("Depressants & Precursors", "Depressants").replace("Dissociative's", "Dissociatives")}
                    </Badge>
                  </div>
                  {groupItems.map((item, idx) => {
                    const row = rows[item.id];
                    if (!row) return null;
                    const diffVal = diff(row.starting, row.ending);
                    const subLabel = isGroup ? (item.price ? `$${parseFloat(item.price).toFixed(0)}` : `#${idx + 1}`) : null;
                    return (
                      <div
                        key={item.id}
                        className={`grid grid-cols-[1fr_80px_100px_100px_100px_90px] gap-2 px-3 py-2 items-center border-b border-border/20 last:border-0 transition-colors ${row.dirty ? "bg-primary/[0.03]" : "hover:bg-muted/10"}`}
                      >
                        <div className="text-xs text-muted-foreground truncate">
                          {subLabel && <span className="font-mono text-[11px] bg-muted/40 rounded px-1.5 py-0.5 mr-2">{subLabel}</span>}
                          {isGroup ? "" : <span className="text-foreground/70">{item.luciferCruzName || item.name}</span>}
                          {row.dirty && <span className="ml-1.5 text-[10px] text-primary font-medium">•</span>}
                        </div>
                        <div className="flex justify-center">
                          <button
                            onClick={() => updateRow(item.id, "unit", row.unit === "G" ? "#" : "G")}
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-full border transition-all ${row.unit === "G" ? "border-amber-500/40 bg-amber-500/10 text-amber-400" : "border-border/50 bg-muted/30 text-muted-foreground"}`}
                          >
                            {row.unit}
                          </button>
                        </div>
                        <div>
                          <Input
                            value={row.starting}
                            onChange={e => updateRow(item.id, "starting", e.target.value)}
                            onBlur={() => saveRow(item.id)}
                            placeholder="—"
                            className="h-7 text-xs text-center rounded-lg bg-background/60 border-border/40 font-mono"
                          />
                        </div>
                        <div>
                          <Input
                            value={row.ending}
                            onChange={e => updateRow(item.id, "ending", e.target.value)}
                            placeholder="—"
                            className="h-7 text-xs text-center rounded-lg bg-background/60 border-border/40 font-mono"
                          />
                        </div>
                        <div className="text-center">
                          {diffVal !== "" ? (
                            <span className={`text-xs font-mono font-semibold ${parseFloat(diffVal) < 0 ? "text-red-400" : parseFloat(diffVal) > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                              {diffVal}
                            </span>
                          ) : <span className="text-muted-foreground/30 text-xs">—</span>}
                        </div>
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
              onBlur={() => { const n = parseFloat(pettyCash); if (!isNaN(n)) setPettyCash(n.toFixed(2)); }}
              className="pl-7 w-40 h-10 text-2xl font-bold text-amber-300 bg-transparent border-amber-500/20 rounded-xl"
            />
          </div>
          {pettyCashDirty && <span className="text-xs text-amber-400/70 font-medium">Unsaved</span>}
        </div>
      </div>

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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminInventory() {
  const { getToken } = useAuth();
  const [tab, setTab] = useState<"stock" | "template">("template");

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
          <ClipboardList size={18} className="text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Inventory</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Raw material tracking and shift template management</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-muted/20 border border-border/40 rounded-xl w-fit">
        {[
          { key: "template" as const, label: "Raw Materials", icon: Settings2 },
          { key: "stock" as const, label: "Stock Levels", icon: ClipboardList },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold tracking-wide uppercase transition-all ${
              tab === key
                ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "template" ? (
        <ShiftTemplateTab getToken={getToken} />
      ) : (
        <StockLevelsTab getToken={getToken} />
      )}
    </div>
  );
}
