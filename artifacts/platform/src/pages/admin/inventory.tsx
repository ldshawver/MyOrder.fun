import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@clerk/react";
import {
  Save, ClipboardList, DollarSign, RefreshCw, Calendar,
  Settings2, Eye, EyeOff, Loader2, Plus, Trash2, RotateCcw, Link2, Database,
  Package, MapPin, BarChart3, AlertTriangle, ShieldOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

// ─── Stock Levels Types ───────────────────────────────────────────────────────

type InvLocEntry = {
  locationId: number;
  name: string;
  type: string;
  qty: number;
  par: number;
};

type InvItem = {
  id: number;
  name: string;
  alavontName: string | null;
  luciferCruzName: string | null;
  category: string;
  price: string;
  stockQuantity: number | null;
  stockUnit: string;
  totalStock: number;
  isAvailable: boolean;
  locations: InvLocEntry[];
};

type LocCellState = {
  qty: string;
  par: string;
  dirty: boolean;
  saving: boolean;
};

type OrphanBalanceItem = {
  id: number;
  productId: number;
  locationId: number;
  quantityOnHand: number;
  parLevel: number;
  inventoryKind: "sellable_catalog" | "non_sellable_supply";
  quarantineStatus: "active" | "quarantined";
  quarantineReason: string | null;
  productName: string | null;
  locationName: string | null;
  reason: "missing_catalog_product" | "missing_location" | "non_sellable_supply" | "quarantined";
};

// ─── Shift Template Types ─────────────────────────────────────────────────────

type CatalogOption = {
  id: number;
  label: string;
  category: string;
  secondaryLabel?: string | null;
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
  parLevel: string | null;
};

type TemplateRowEdit = {
  itemName: string;
  unitType: string;
  startingQuantityDefault: string;
  currentStock: string;
  isActive: boolean;
  catalogItemId: number | null;
  deductionQty: string;
  parLevel: string;
  dirty: boolean;
  saving: boolean;
};

// ─── Constants ────────────────────────────────────────────────────────────────

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
        fetch("/api/catalog?limit=500&mode=alavont", { headers }),
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
          parLevel: r.parLevel != null ? String(parseFloat(String(r.parLevel))) : "0",
          dirty: false,
          saving: false,
        };
      }
      setEdits(init);

      if (catRes.ok) {
        const catData = await catRes.json();
        const opts: CatalogOption[] = (catData.items ?? []).map((it: InvItem & { alavontCategory?: string | null }) => ({
          id: it.id,
          label: it.alavontName || it.luciferCruzName || it.name,
          category: it.alavontCategory || it.category,
          secondaryLabel: it.name,
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
          parLevel: parseFloat(edit.parLevel) || 0,
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
          parLevel: "0",
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

  const colHeader = "grid grid-cols-[1fr_50px_88px_100px_180px_76px_70px_44px_32px] gap-2 px-3 text-[10px] font-bold text-muted-foreground uppercase tracking-widest";
  const colRow = "grid grid-cols-[1fr_50px_88px_100px_180px_76px_70px_44px_32px] gap-2 px-3 py-2 items-center transition-colors";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Inventory</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Master inventory rows can be linked to menu items; stock auto-deducts when linked items are fulfilled. Managers can add, edit, or delete items.
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
        <div className="text-center" title="Par level — minimum stock kept on hand. When end-of-shift count is below par, a restock slip can be printed.">Par Level</div>
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
                        <option key={opt.id} value={opt.id}>
                          {opt.label}{opt.secondaryLabel && opt.secondaryLabel !== opt.label ? ` (${opt.secondaryLabel})` : ""}
                        </option>
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

                  {/* Par Level */}
                  <Input
                    type="number"
                    min="0"
                    step={edit.unitType === "G" ? "0.1" : "1"}
                    value={edit.parLevel}
                    onChange={e => update(row.id, "parLevel", e.target.value)}
                    onBlur={() => saveRow(row.id)}
                    title="Par level — when end-of-shift quantity falls below this, the supervisor sees this row on the restock slip. 0 disables the alert."
                    data-testid={`input-par-level-${row.id}`}
                    className="h-7 text-xs text-center rounded-lg bg-background/60 border-border/40 font-mono"
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

// ─── CSR Boxes Tab ────────────────────────────────────────────────────────────

type CsrBox = {
  id: number;
  slug: string;
  label: string;
  description: string | null;
  location: string | null;
  isActive: boolean;
  displayOrder: number;
};

function CsrBoxesTab({ getToken }: { getToken: () => Promise<string | null> }) {
  const [boxes, setBoxes] = useState<CsrBox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<number | "new", boolean>>({} as Record<number | "new", boolean>);
  const [edits, setEdits] = useState<Record<number, Partial<CsrBox>>>({});
  const [showNew, setShowNew] = useState(false);
  const [newBox, setNewBox] = useState({ label: "", description: "", location: "" });

  const fetchBoxes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/csr-boxes", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("Failed to load boxes");
      const data = await res.json();
      setBoxes(data.boxes ?? []);
    } catch {
      setError("Could not load CSR boxes.");
    }
    setLoading(false);
  }, [getToken]);

  useEffect(() => { fetchBoxes(); }, [fetchBoxes]);

  const save = async (id: number) => {
    const patch = edits[id];
    if (!patch || Object.keys(patch).length === 0) return;
    setSaving(s => ({ ...s, [id]: true }));
    try {
      const token = await getToken();
      const res = await fetch(`/api/admin/csr-boxes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json();
      setBoxes(prev => prev.map(b => b.id === id ? data.box : b));
      setEdits(prev => { const next = { ...prev }; delete next[id]; return next; });
    } catch { setError("Failed to save box."); }
    setSaving(s => ({ ...s, [id]: false }));
  };

  const toggleActive = async (box: CsrBox) => {
    setSaving(s => ({ ...s, [box.id]: true }));
    try {
      const token = await getToken();
      const res = await fetch(`/api/admin/csr-boxes/${box.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isActive: !box.isActive }),
      });
      if (!res.ok) throw new Error("Toggle failed");
      const data = await res.json();
      setBoxes(prev => prev.map(b => b.id === box.id ? data.box : b));
    } catch { setError("Failed to update box."); }
    setSaving(s => ({ ...s, [box.id]: false }));
  };

  const createBox = async () => {
    if (!newBox.label.trim()) return;
    setSaving(s => ({ ...s, new: true }));
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/csr-boxes", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ label: newBox.label.trim(), description: newBox.description || null, location: newBox.location || null, displayOrder: boxes.length * 10 }),
      });
      if (!res.ok) throw new Error("Create failed");
      const data = await res.json();
      setBoxes(prev => [...prev, data.box]);
      setNewBox({ label: "", description: "", location: "" });
      setShowNew(false);
    } catch { setError("Failed to create box."); }
    setSaving(s => ({ ...s, new: false }));
  };

  if (loading) return (
    <div className="flex items-center justify-center gap-3 py-16 text-muted-foreground text-sm">
      <Loader2 size={16} className="animate-spin" /> Loading boxes…
    </div>
  );

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-400">{error}</div>}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          CSR boxes are tenant-scoped. Active boxes appear in the CSR clock-in dropdown.
        </p>
        <Button size="sm" onClick={() => setShowNew(v => !v)} className="gap-2 rounded-xl h-7 text-xs">
          <Plus size={12} /> Add Box
        </Button>
      </div>

      {showNew && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3">
          <p className="text-xs font-semibold text-primary uppercase tracking-wider">New Box</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Label *</label>
              <Input value={newBox.label} onChange={e => setNewBox(v => ({ ...v, label: e.target.value }))} placeholder="CSR Sales Box 3" className="h-8 text-sm rounded-lg" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Location</label>
              <Input value={newBox.location} onChange={e => setNewBox(v => ({ ...v, location: e.target.value }))} placeholder="South corner" className="h-8 text-sm rounded-lg" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Description</label>
              <Input value={newBox.description} onChange={e => setNewBox(v => ({ ...v, description: e.target.value }))} placeholder="Optional notes" className="h-8 text-sm rounded-lg" />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowNew(false)} className="h-7 text-xs rounded-xl">Cancel</Button>
            <Button size="sm" onClick={createBox} disabled={!newBox.label.trim() || saving["new"]} className="h-7 text-xs gap-1.5 rounded-xl">
              {saving["new"] ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} Create
            </Button>
          </div>
        </div>
      )}

      {boxes.length === 0 && !showNew && (
        <div className="rounded-xl border border-dashed border-border/40 p-10 text-center text-xs text-muted-foreground">
          No CSR boxes configured. Click <strong>Add Box</strong> to create one.
        </div>
      )}

      {boxes.map(box => {
        const edit = edits[box.id] ?? {};
        const isDirty = Object.keys(edit).length > 0;
        return (
          <div key={box.id} className={`rounded-xl border overflow-hidden transition-colors ${box.isActive ? "border-border/40" : "border-border/20 opacity-60"}`}>
            <div className="flex items-center justify-between px-4 py-3 bg-muted/10 border-b border-border/20">
              <div className="flex items-center gap-2">
                <Package size={13} className="text-primary" />
                <span className="text-sm font-semibold">{edit.label ?? box.label}</span>
                <span className="text-[10px] font-mono text-muted-foreground/50 bg-muted/30 px-1.5 py-0.5 rounded">{box.slug}</span>
                {!box.isActive && <Badge variant="outline" className="text-[10px] h-4 text-muted-foreground border-border/30">Inactive</Badge>}
                {box.isActive && <Badge variant="outline" className="text-[10px] h-4 text-green-400 border-green-500/30">Active</Badge>}
              </div>
              <div className="flex items-center gap-2">
                {isDirty && (
                  <Button size="sm" onClick={() => save(box.id)} disabled={saving[box.id]} className="h-6 text-[11px] gap-1 rounded-lg px-2.5">
                    {saving[box.id] ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />} Save
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => toggleActive(box)} disabled={saving[box.id]} className="h-6 text-[11px] gap-1 rounded-lg px-2.5 text-muted-foreground">
                  {box.isActive ? <EyeOff size={10} /> : <Eye size={10} />}
                  {box.isActive ? "Deactivate" : "Activate"}
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 px-4 py-3">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 block">Label</label>
                <Input
                  value={edit.label ?? box.label}
                  onChange={e => setEdits(prev => ({ ...prev, [box.id]: { ...(prev[box.id] ?? {}), label: e.target.value } }))}
                  className="h-7 text-xs rounded-lg"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 block">Location</label>
                <Input
                  value={edit.location ?? box.location ?? ""}
                  onChange={e => setEdits(prev => ({ ...prev, [box.id]: { ...(prev[box.id] ?? {}), location: e.target.value } }))}
                  placeholder="e.g. South corner"
                  className="h-7 text-xs rounded-lg"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 block">Description</label>
                <Input
                  value={edit.description ?? box.description ?? ""}
                  onChange={e => setEdits(prev => ({ ...prev, [box.id]: { ...(prev[box.id] ?? {}), description: e.target.value } }))}
                  placeholder="Optional notes"
                  className="h-7 text-xs rounded-lg"
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Stock Levels Tab ─────────────────────────────────────────────────────────

function StockLevelsTab({ getToken }: { getToken: () => Promise<string | null> }) {
  const [items, setItems] = useState<InvItem[]>([]);
  const [locations, setLocations] = useState<{ id: number; name: string; type: string }[]>([]);
  // Key: `${productId}:${locationId}`
  const [cells, setCells] = useState<Record<string, LocCellState>>({});
  const [pettyCash, setPettyCash] = useState<string>("0.00");
  const [orphanBalances, setOrphanBalances] = useState<OrphanBalanceItem[]>([]);
  const [orphanActionError, setOrphanActionError] = useState<string | null>(null);
  const [pettyCashDirty, setPettyCashDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ensuring, setEnsuring] = useState(false);
  const [ensureMsg, setEnsureMsg] = useState<string | null>(null);
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
      const itemsData: InvItem[] = data.items ?? [];
      const locData: { id: number; name: string; type: string }[] = data.locations ?? [];
      setItems(itemsData);
      setLocations(locData);
      setPettyCash(parseFloat(String(data.pettyCash ?? 0)).toFixed(2));

      const orphanRes = await fetch("/api/admin/inventory/orphans", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (orphanRes.ok) {
        const orphanData = await orphanRes.json();
        setOrphanBalances(orphanData.items ?? []);
      }

      const init: Record<string, LocCellState> = {};
      for (const item of itemsData) {
        for (const loc of (item.locations ?? [])) {
          init[`${item.id}:${loc.locationId}`] = {
            qty: String(loc.qty),
            par: String(loc.par),
            dirty: false,
            saving: false,
          };
        }
      }
      setCells(init);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { fetchInventory(); }, [fetchInventory]);

  function updateCell(productId: number, locationId: number, field: "qty" | "par", val: string) {
    const key = `${productId}:${locationId}`;
    setCells(prev => ({
      ...prev,
      [key]: { ...(prev[key] ?? { qty: "0", par: "0", dirty: false, saving: false }), [field]: val, dirty: true },
    }));
  }

  async function saveCell(productId: number, locationId: number) {
    const key = `${productId}:${locationId}`;
    const cell = cells[key];
    if (!cell?.dirty) return;
    setCells(prev => ({ ...prev, [key]: { ...prev[key], saving: true } }));
    try {
      const token = await getToken();
      await fetch(`/api/admin/inventory/balance/${productId}/${locationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ qty: parseFloat(cell.qty) || 0, par: parseFloat(cell.par) || 0 }),
      });
      setCells(prev => ({ ...prev, [key]: { ...prev[key], dirty: false, saving: false } }));
    } catch {
      setCells(prev => ({ ...prev, [key]: { ...prev[key], saving: false } }));
    }
  }

  async function saveAll() {
    setSaving(true);
    const token = await getToken();
    const dirtyEntries = Object.entries(cells).filter(([, c]) => c.dirty);
    await Promise.all(dirtyEntries.map(([key, cell]) => {
      const [pidStr, lidStr] = key.split(":");
      return fetch(`/api/admin/inventory/balance/${pidStr}/${lidStr}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ qty: parseFloat(cell.qty) || 0, par: parseFloat(cell.par) || 0 }),
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
    setCells(prev => {
      const next = { ...prev };
      for (const [key] of dirtyEntries) next[key] = { ...next[key], dirty: false };
      return next;
    });
    setSaving(false);
  }


  async function updateOrphanBalance(id: number, patch: Partial<Pick<OrphanBalanceItem, "inventoryKind" | "quarantineStatus" | "quarantineReason">>) {
    setOrphanActionError(null);
    try {
      const token = await getToken();
      const res = await fetch(`/api/admin/inventory/orphans/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to update inventory quarantine status");
      }
      await fetchInventory();
    } catch (e: unknown) {
      setOrphanActionError(e instanceof Error ? e.message : "Failed to update inventory quarantine status");
    }
  }

  async function ensureAllBalances() {
    setEnsuring(true);
    setEnsureMsg(null);
    try {
      const token = await getToken();
      const r = await fetch("/api/admin/inventory/ensure-balances", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      setEnsureMsg(`✓ Created ${data.created ?? 0} new balance row${data.created !== 1 ? "s" : ""}`);
      await fetchInventory();
    } catch {
      setEnsureMsg("Failed to ensure balances");
    } finally {
      setEnsuring(false);
    }
  }

  const visibleItems = items.filter(it => !EXCLUDE_CATEGORIES.includes(it.category));
  const byCategory: Record<string, InvItem[]> = {};
  for (const item of visibleItems) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }
  const sortedCats = Object.keys(byCategory).sort((a, b) => categoryOrder(a) - categoryOrder(b));
  const dirtyCellCount = Object.values(cells).filter(c => c.dirty).length;

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
      {/* Header toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Calendar size={11} />
          {date}
        </div>
        <div className="flex items-center gap-2">
          {ensureMsg && (
            <span className="text-xs text-emerald-400">{ensureMsg}</span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={ensureAllBalances}
            disabled={ensuring}
            className="gap-1.5 h-7 text-xs rounded-xl"
          >
            {ensuring ? <RefreshCw size={11} className="animate-spin" /> : <Database size={11} />}
            Ensure All Balances
          </Button>
          <Button
            onClick={saveAll}
            disabled={saving || (dirtyCellCount === 0 && !pettyCashDirty)}
            className="gap-2 rounded-xl h-7"
            size="sm"
          >
            {saving ? <RefreshCw size={11} className="animate-spin" /> : <Save size={11} />}
            {saving ? "Saving…" : dirtyCellCount > 0 || pettyCashDirty
              ? `Save (${dirtyCellCount + (pettyCashDirty ? 1 : 0)})`
              : "All Saved"}
          </Button>
        </div>
      </div>


      {orphanBalances.length > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 text-amber-300" />
            <div>
              <div className="text-sm font-bold text-amber-200">Inventory quarantine report</div>
              <p className="text-xs text-amber-100/80">
                {orphanBalances.length} balance row{orphanBalances.length === 1 ? "" : "s"} are excluded from customer ordering and sellable stock because they do not resolve to active catalog inventory or are marked as non-sellable supplies.
              </p>
            </div>
          </div>
          {orphanActionError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{orphanActionError}</div>
          )}
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {orphanBalances.slice(0, 9).map(row => (
              <div key={row.id} className="rounded-xl border border-amber-500/20 bg-background/40 p-3 text-xs space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">Balance #{row.id}</span>
                  <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-200">{row.reason.replaceAll("_", " ")}</Badge>
                </div>
                <div className="text-muted-foreground">
                  Product: {row.productName ?? `missing catalog #${row.productId}`} · Location: {row.locationName ?? `missing location #${row.locationId}`}
                </div>
                <div className="font-mono text-[11px]">qty {row.quantityOnHand} · par {row.parLevel}</div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => void updateOrphanBalance(row.id, { inventoryKind: "non_sellable_supply", quarantineStatus: "quarantined", quarantineReason: "Classified by admin as non-sellable supply" })}>
                    <ShieldOff size={11} /> Mark supply
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void updateOrphanBalance(row.id, { quarantineStatus: "quarantined", quarantineReason: "Quarantined by admin for inventory cleanup" })}>
                    Quarantine
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-location grid */}
      <div className="overflow-x-auto rounded-2xl border border-border/30">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/30 bg-muted/20">
              <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Item</th>
              {locations.map(loc => (
                <th key={loc.id} className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-widest text-muted-foreground min-w-[90px]">
                  <div>{loc.name.replace("CSR Sales ", "")}</div>
                  <div className="text-[9px] font-normal opacity-60 normal-case">{loc.type === "csr_box" ? "CSR Box" : loc.type}</div>
                </th>
              ))}
              <th className="px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-widest text-primary min-w-[60px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {sortedCats.map(cat => {
              const catItems = byCategory[cat];
              return (
                <>
                  <tr key={`cat-${cat}`} className="bg-muted/10">
                    <td
                      colSpan={locations.length + 2}
                      className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground border-b border-t border-border/20"
                    >
                      {cat.replace("Psychedelics & Hallucinogens", "Psychedelics").replace("Depressants & Precursors", "Depressants").replace("Dissociative's", "Dissociatives")}
                    </td>
                  </tr>
                  {catItems.map(item => {
                    const liveTotal = (item.locations ?? []).reduce((s, l) => {
                      const cell = cells[`${item.id}:${l.locationId}`];
                      return s + (cell ? (parseFloat(cell.qty) || 0) : l.qty);
                    }, 0);
                    const rowDirty = locations.some(l => cells[`${item.id}:${l.id}`]?.dirty);
                    return (
                      <tr
                        key={item.id}
                        className={`border-b border-border/10 transition-colors ${rowDirty ? "bg-primary/[0.03]" : "hover:bg-muted/5"}`}
                      >
                        <td className="px-3 py-2">
                          <div className="font-medium text-sm leading-tight">{item.alavontName ?? item.name}</div>
                          {item.luciferCruzName && (
                            <div className="text-[10px] text-muted-foreground">{item.luciferCruzName}</div>
                          )}
                          {!item.isAvailable && (
                            <span className="text-[9px] text-red-400 bg-red-400/10 px-1.5 py-0.5 rounded-full">Hidden</span>
                          )}
                        </td>
                        {locations.map(loc => {
                          const key = `${item.id}:${loc.id}`;
                          const cell = cells[key] ?? { qty: "0", par: "0", dirty: false, saving: false };
                          const belowPar = parseFloat(cell.qty) < parseFloat(cell.par) && parseFloat(cell.par) > 0;
                          return (
                            <td key={loc.id} className={`px-2 py-1.5 ${cell.dirty ? "bg-primary/[0.05]" : ""}`}>
                              <div className="flex flex-col gap-0.5 items-center">
                                <Input
                                  value={cell.qty}
                                  onChange={e => updateCell(item.id, loc.id, "qty", e.target.value)}
                                  onBlur={() => saveCell(item.id, loc.id)}
                                  title="Quantity on hand"
                                  className={`h-6 w-16 text-center text-xs font-mono rounded px-1 ${belowPar ? "border-amber-500/50 text-amber-300" : ""} ${cell.saving ? "opacity-50" : ""}`}
                                />
                                <Input
                                  value={cell.par}
                                  onChange={e => updateCell(item.id, loc.id, "par", e.target.value)}
                                  onBlur={() => saveCell(item.id, loc.id)}
                                  title="Par level"
                                  className="h-5 w-16 text-center text-[10px] font-mono rounded px-1 opacity-50 border-dashed"
                                />
                              </div>
                            </td>
                          );
                        })}
                        <td className={`px-3 py-2 text-center font-mono font-bold text-sm ${liveTotal === 0 ? "text-muted-foreground/40" : "text-primary"}`}>
                          {liveTotal % 1 === 0 ? liveTotal : liveTotal.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </>
              );
            })}
          </tbody>
        </table>
        {visibleItems.length === 0 && (
          <div className="py-16 text-center text-sm text-muted-foreground">
            <Package size={32} className="mx-auto mb-3 opacity-20" />
            No inventory items found. Click <strong>Ensure All Balances</strong> to seed from catalog.
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 px-1 text-[10px] text-muted-foreground">
        <span>Top cell = qty on hand · Bottom cell (dashed) = par level</span>
        <span className="text-amber-400">Amber = below par</span>
      </div>

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

      {(dirtyCellCount > 0 || pettyCashDirty) && (
        <div className="flex items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {dirtyCellCount} cell{dirtyCellCount !== 1 ? "s" : ""} with unsaved changes
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

// ─── Inventory Locations Tab ──────────────────────────────────────────────────

type InventoryLocation = {
  id: number;
  name: string;
  type: string;
  csrBoxId: number | null;
  isActive: boolean;
  displayOrder: number;
};

function LocationsTab({ getToken }: { getToken: () => Promise<string | null> }) {
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<number | "new", boolean>>({} as Record<number | "new", boolean>);
  const [showNew, setShowNew] = useState(false);
  const [newLoc, setNewLoc] = useState({ name: "", type: "storefront" });

  const fetchLocations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/inventory-locations", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("Failed to load locations");
      const data = await res.json();
      setLocations(data.locations ?? []);
    } catch { setError("Could not load locations."); }
    setLoading(false);
  }, [getToken]);

  useEffect(() => { fetchLocations(); }, [fetchLocations]);

  const toggleActive = async (loc: InventoryLocation) => {
    setSaving(s => ({ ...s, [loc.id]: true }));
    try {
      const token = await getToken();
      const res = await fetch(`/api/admin/inventory-locations/${loc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isActive: !loc.isActive }),
      });
      if (!res.ok) throw new Error("Update failed");
      const data = await res.json();
      setLocations(prev => prev.map(l => l.id === loc.id ? data.location : l));
    } catch { setError("Failed to update."); }
    setSaving(s => ({ ...s, [loc.id]: false }));
  };

  const createLocation = async () => {
    if (!newLoc.name.trim()) return;
    setSaving(s => ({ ...s, new: true }));
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/inventory-locations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: newLoc.name.trim(), type: newLoc.type, displayOrder: locations.length * 10 }),
      });
      if (!res.ok) throw new Error("Create failed");
      const data = await res.json();
      setLocations(prev => [...prev, data.location]);
      setNewLoc({ name: "", type: "storefront" });
      setShowNew(false);
    } catch { setError("Failed to create location."); }
    setSaving(s => ({ ...s, new: false }));
  };

  const TYPE_LABELS: Record<string, string> = { csr_box: "CSR Box", storefront: "Storefront", backstock: "Backstock" };
  const TYPE_COLORS: Record<string, string> = {
    csr_box: "text-blue-400 border-blue-500/30",
    storefront: "text-emerald-400 border-emerald-500/30",
    backstock: "text-amber-400 border-amber-500/30",
  };

  if (loading) return (
    <div className="flex items-center justify-center gap-3 py-16 text-muted-foreground text-sm">
      <Loader2 size={16} className="animate-spin" /> Loading locations…
    </div>
  );

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-400">{error}</div>}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Locations are the physical storage areas tracked per-product. CSR Sales Box 1 &amp; 2, Storefront, and Backstock are auto-seeded.
        </p>
        <Button size="sm" onClick={() => setShowNew(v => !v)} className="gap-2 rounded-xl h-7 text-xs">
          <Plus size={12} /> Add Location
        </Button>
      </div>

      {showNew && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3">
          <p className="text-xs font-semibold text-primary uppercase tracking-wider">New Location</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Name *</label>
              <Input value={newLoc.name} onChange={e => setNewLoc(v => ({ ...v, name: e.target.value }))} placeholder="e.g. Overflow Backstock" className="h-8 text-sm rounded-lg" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Type</label>
              <select
                value={newLoc.type}
                onChange={e => setNewLoc(v => ({ ...v, type: e.target.value }))}
                className="w-full h-8 text-sm rounded-lg bg-background border border-border/40 px-2 text-foreground"
              >
                <option value="storefront">Storefront</option>
                <option value="backstock">Backstock</option>
                <option value="csr_box">CSR Box</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowNew(false)} className="h-7 text-xs rounded-xl">Cancel</Button>
            <Button size="sm" onClick={createLocation} disabled={!newLoc.name.trim() || saving["new"]} className="h-7 text-xs gap-1.5 rounded-xl">
              {saving["new"] ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} Create
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {locations.map(loc => (
          <div key={loc.id} className={`rounded-xl border overflow-hidden transition-colors ${loc.isActive ? "border-border/40" : "border-border/20 opacity-60"}`}>
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <MapPin size={13} className="text-muted-foreground/50" />
                <span className="text-sm font-semibold">{loc.name}</span>
                <Badge variant="outline" className={`text-[10px] h-4 ${TYPE_COLORS[loc.type] ?? "text-muted-foreground"}`}>
                  {TYPE_LABELS[loc.type] ?? loc.type}
                </Badge>
                {!loc.isActive && <Badge variant="outline" className="text-[10px] h-4 text-muted-foreground border-border/30">Inactive</Badge>}
              </div>
              <Button size="sm" variant="ghost" onClick={() => toggleActive(loc)} disabled={saving[loc.id]} className="h-6 text-[11px] gap-1 rounded-lg px-2.5 text-muted-foreground">
                {saving[loc.id] ? <Loader2 size={10} className="animate-spin" /> : loc.isActive ? <EyeOff size={10} /> : <Eye size={10} />}
                {loc.isActive ? "Deactivate" : "Activate"}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {locations.length === 0 && !showNew && (
        <div className="rounded-xl border border-dashed border-border/40 p-10 text-center text-xs text-muted-foreground">
          No locations yet — they will be auto-seeded on first API load.
        </div>
      )}
    </div>
  );
}

// ─── Stock Grid Tab ───────────────────────────────────────────────────────────

type InventoryBalance = {
  id: number;
  productId: number;
  locationId: number;
  quantityOnHand: number;
  parLevel: number;
  productName: string;
  alavontName: string | null;
  locationName: string;
  locationType: string;
};

function StockGridTab({ getToken }: { getToken: () => Promise<string | null> }) {
  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [parEdits, setParEdits] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<Record<number, boolean>>({});
  const [filterLoc, setFilterLoc] = useState<number | "all">("all");

  const fetchBalances = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const url = filterLoc === "all" ? "/api/admin/inventory-balances" : `/api/admin/inventory-balances?locationId=${filterLoc}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("Failed to load balances");
      const data = await res.json();
      setBalances(data.balances ?? []);
      setLocations(data.locations ?? []);
      setEdits({});
      setParEdits({});
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Network error"); }
    setLoading(false);
  }, [getToken, filterLoc]);

  useEffect(() => { fetchBalances(); }, [fetchBalances]);

  const saveBalance = async (balance: InventoryBalance) => {
    const rawQty = edits[balance.id];
    const rawPar = parEdits[balance.id];
    if (rawQty === undefined && rawPar === undefined) return;
    const payload: { quantityOnHand?: number; parLevel?: number } = {};
    if (rawQty !== undefined) {
      const qty = parseFloat(rawQty);
      if (isNaN(qty)) return;
      payload.quantityOnHand = qty;
    }
    if (rawPar !== undefined) {
      const par = parseFloat(rawPar);
      if (isNaN(par)) return;
      payload.parLevel = par;
    }
    setSaving(s => ({ ...s, [balance.id]: true }));
    try {
      const token = await getToken();
      const res = await fetch(`/api/admin/inventory-balances/${balance.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json();
      setBalances(prev => prev.map(b => b.id === balance.id ? { ...b, quantityOnHand: data.balance.quantityOnHand, parLevel: data.balance.parLevel } : b));
      setEdits(prev => { const n = { ...prev }; delete n[balance.id]; return n; });
      setParEdits(prev => { const n = { ...prev }; delete n[balance.id]; return n; });
    } catch { setError("Failed to save."); }
    setSaving(s => ({ ...s, [balance.id]: false }));
  };

  // Group by product for the grid view
  const productMap = new Map<number, { name: string; balances: InventoryBalance[] }>();
  for (const b of balances) {
    if (!productMap.has(b.productId)) {
      productMap.set(b.productId, { name: b.alavontName ?? b.productName, balances: [] });
    }
    productMap.get(b.productId)!.balances.push(b);
  }
  const products = Array.from(productMap.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));

  if (loading) return (
    <div className="flex items-center justify-center gap-3 py-16 text-muted-foreground text-sm">
      <Loader2 size={16} className="animate-spin" /> Loading stock grid…
    </div>
  );

  if (error) return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 p-4 text-sm">{error}</div>
  );

  const activeLocations = locations.filter(l => l.isActive);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <p className="text-xs text-muted-foreground flex-1">
          One imported row is one inventory product. Only Alavont/master inventory rows appear here; safe/cart-conversion columns stay hidden. Edit quantity and location par inline; row totals show on-hand stock available to sell.
        </p>
        <div className="flex items-center gap-2">
          <select
            value={filterLoc}
            onChange={e => setFilterLoc(e.target.value === "all" ? "all" : parseInt(e.target.value))}
            className="h-7 text-xs rounded-lg bg-background border border-border/40 px-2 text-foreground"
          >
            <option value="all">All Locations</option>
            {activeLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <Button size="sm" variant="ghost" onClick={fetchBalances} className="h-7 text-xs gap-1 rounded-xl">
            <RefreshCw size={11} /> Refresh
          </Button>
        </div>
      </div>

      {products.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/40 p-10 text-center text-xs text-muted-foreground">
          No inventory balances yet. They are seeded automatically when a CSR uses the inventory template.
        </div>
      ) : (
        <div className="rounded-xl border border-border/40 overflow-hidden">
          {/* Header */}
          <div className="grid gap-2 px-4 py-2 bg-muted/20 border-b border-border/30 text-[10px] font-bold text-muted-foreground uppercase tracking-widest"
            style={{ gridTemplateColumns: `1fr repeat(${Math.max(activeLocations.length, 1)}, 120px) 80px` }}>
            <div>Product</div>
            {activeLocations.map(l => <div key={l.id} className="text-center">{l.name}<span className="block text-[9px] font-medium normal-case tracking-normal">Qty / Par</span></div>)}
            <div className="text-center">Total</div>
          </div>

          {/* Rows */}
          {products.map(([productId, { name, balances: pBalances }]) => (
            <div key={productId}
              className="grid gap-2 px-4 py-2 border-b border-border/20 last:border-0 hover:bg-muted/10 transition-colors items-center"
              style={{ gridTemplateColumns: `1fr repeat(${Math.max(activeLocations.length, 1)}, 120px) 80px` }}>
              <div className="text-xs font-medium truncate">{name}</div>
              {activeLocations.map(loc => {
                const b = pBalances.find(pb => pb.locationId === loc.id);
                if (!b) return <div key={loc.id} className="text-center text-muted-foreground/30 text-xs">—</div>;
                const editVal = edits[b.id];
                const parEditVal = parEdits[b.id];
                const isDirty = editVal !== undefined;
                const isParDirty = parEditVal !== undefined;
                return (
                  <div key={loc.id} className="flex items-center justify-center gap-1">
                    {saving[b.id] ? (
                      <Loader2 size={11} className="animate-spin text-muted-foreground" />
                    ) : (
                      <>
                        <Input
                          value={isDirty ? editVal : String(b.quantityOnHand)}
                          onChange={e => setEdits(prev => ({ ...prev, [b.id]: e.target.value }))}
                          onBlur={() => saveBalance(b)}
                          title={`${loc.name} on-hand quantity`}
                          className={`h-6 w-14 text-xs text-center font-mono rounded-lg p-0 ${isDirty ? "border-primary/50 bg-primary/5" : "bg-transparent border-transparent hover:border-border/50"}`}
                        />
                        <Input
                          value={isParDirty ? parEditVal : String(b.parLevel)}
                          onChange={e => setParEdits(prev => ({ ...prev, [b.id]: e.target.value }))}
                          onBlur={() => saveBalance(b)}
                          title={`${loc.name} par level`}
                          className={`h-6 w-14 text-xs text-center font-mono rounded-lg p-0 ${isParDirty ? "border-amber-400/50 bg-amber-400/5" : "bg-transparent border-transparent hover:border-border/50"}`}
                        />
                      </>
                    )}
                  </div>
                );
              })}
              <div className="text-center text-xs font-mono font-semibold text-emerald-400">
                {pBalances.reduce((sum, balance) => sum + balance.quantityOnHand, 0)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminInventory() {
  const { getToken } = useAuth();
  const [tab, setTab] = useState<"stock" | "template" | "boxes" | "locations" | "stockgrid">("template");

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
          <ClipboardList size={18} className="text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Inventory</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Master inventory, shift template, CSR boxes, storefront, backstock, and per-location stock</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 p-1 bg-muted/20 border border-border/40 rounded-xl w-fit">
        {[
          { key: "template" as const, label: "Inventory", icon: Settings2 },
          { key: "stock" as const, label: "Stock Levels", icon: ClipboardList },
          { key: "boxes" as const, label: "CSR Boxes", icon: Package },
          { key: "locations" as const, label: "Locations", icon: MapPin },
          { key: "stockgrid" as const, label: "Stock Grid", icon: BarChart3 },
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
      ) : tab === "boxes" ? (
        <CsrBoxesTab getToken={getToken} />
      ) : tab === "locations" ? (
        <LocationsTab getToken={getToken} />
      ) : tab === "stockgrid" ? (
        <StockGridTab getToken={getToken} />
      ) : (
        <StockLevelsTab getToken={getToken} />
      )}
    </div>
  );
}
