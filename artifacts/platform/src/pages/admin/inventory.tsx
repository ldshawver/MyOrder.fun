import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@clerk/react";
import {
  Save, ClipboardList, DollarSign, RefreshCw, Calendar,
  Settings2, Eye, EyeOff, Loader2, Plus, Trash2, RotateCcw, Link2, Database,
  Package, MapPin, AlertTriangle, ShieldOff, Archive, ChevronDown, ChevronRight, Pencil, Search,
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

type InventoryHealthRow = {
  id: number;
  tenantId: number;
  productId: number;
  locationId: number;
  quantityOnHand: number;
  parLevel: number;
  updatedAt?: string | null;
  classification: "sellable_catalog_product" | "non_sellable_supply" | "orphan_balance" | "invalid_location" | "invalid_product";
  inventoryKind: string;
  isSellable: boolean;
  quarantinedAt?: string | null;
  quarantineReason?: string | null;
  productName?: string | null;
  locationName?: string | null;
  locationIsActive?: boolean | null;
};

type InventoryHealthResponse = {
  tenantId: number;
  rows: InventoryHealthRow[];
  summary: Record<InventoryHealthRow["classification"], number>;
};

function inventoryLocationRoleLabel(location: { name: string; type: string }): string {
  if (location.name === "Backstock" || location.type === "backstock") return "Primary Stock";
  return "Allocated / Held Stock";
}

function inventoryLocationShortType(location: { name: string; type: string }): string {
  if (location.name === "Backstock" || location.type === "backstock") return "Backstock";
  if (location.type === "csr_box") return "CSR Box";
  return location.type;
}

type OrphanBalanceItem = {
  id: number;
  tenantId: number;
  productId: number;
  locationId: number;
  quantityOnHand: number;
  parLevel: number;
  inventoryKind: "sellable_catalog" | "non_sellable_supply";
  isSellable?: boolean;
  quarantinedAt?: string | null;
  quarantinedByUserId?: number | null;
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

// Legacy compatibility component; normal navigation uses LocationsTab and no
// longer mounts this independent CSR-box management surface.
export function CsrBoxesTab({ getToken }: { getToken: () => Promise<string | null> }) {
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


  async function updateOrphanBalance(id: number, patch: Partial<Pick<OrphanBalanceItem, "inventoryKind" | "isSellable" | "quarantineReason">> & { quarantined?: boolean }) {
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
  const sortedItems = [...visibleItems].sort((a, b) => a.id - b.id);
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
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => void updateOrphanBalance(row.id, { inventoryKind: "non_sellable_supply", quarantined: true, quarantineReason: "Classified by admin as non-sellable supply" })}>
                    <ShieldOff size={11} /> Mark supply
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void updateOrphanBalance(row.id, { quarantined: true, quarantineReason: "Quarantined by admin for inventory cleanup" })}>
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
                  <div className="text-[9px] font-normal opacity-70 normal-case">{inventoryLocationRoleLabel(loc)}</div>
                  <div className="text-[9px] font-normal opacity-50 normal-case">{inventoryLocationShortType(loc)}</div>
                </th>
              ))}
              <th className="px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-widest text-primary min-w-[60px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map(item => {
              const liveTotal = (item.locations ?? []).reduce((sum, locBalance) => {
                const cell = cells[`${item.id}:${locBalance.locationId}`];
                return sum + (cell ? (parseFloat(cell.qty) || 0) : locBalance.qty);
              }, 0);
              const rowDirty = locations.some(loc => cells[`${item.id}:${loc.id}`]?.dirty);
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

// Preserved only for route-level compatibility while it remains absent from the
// operator navigation. All normal inventory quantity changes use movements.
void StockLevelsTab;

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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");

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

  const saveName = async (loc: InventoryLocation) => {
    const name = editingName.trim();
    if (!name || name === loc.name) { setEditingId(null); return; }
    setSaving(s => ({ ...s, [loc.id]: true }));
    try {
      const token = await getToken();
      const res = await fetch(`/api/admin/inventory-locations/${loc.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ name }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Update failed");
      setLocations(prev => prev.map(item => item.id === loc.id ? data.location : item));
      setEditingId(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Failed to update."); }
    setSaving(s => ({ ...s, [loc.id]: false }));
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
          <div key={loc.id} data-testid={`location-row-${loc.id}`} className={`rounded-xl border overflow-hidden transition-colors ${loc.isActive ? "border-border/40" : "border-border/20 opacity-60"}`}>
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <MapPin size={13} className="text-muted-foreground/50" />
                {editingId === loc.id ? <Input value={editingName} onChange={e => setEditingName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void saveName(loc); if (e.key === "Escape") setEditingId(null); }} className="h-7 w-56 text-sm rounded-lg" autoFocus /> : <span className="text-sm font-semibold">{loc.name}</span>}
                <Badge variant="outline" className={`text-[10px] h-4 ${TYPE_COLORS[loc.type] ?? "text-muted-foreground"}`}>
                  {TYPE_LABELS[loc.type] ?? loc.type}
                </Badge>
                {!loc.isActive && <Badge variant="outline" className="text-[10px] h-4 text-muted-foreground border-border/30">Inactive</Badge>}
              </div>
              {editingId === loc.id ? <Button size="sm" variant="ghost" onClick={() => void saveName(loc)} disabled={saving[loc.id]} className="h-6 text-[11px] gap-1 rounded-lg px-2.5 text-muted-foreground"><Save size={10} />Save</Button> : <Button size="sm" variant="ghost" onClick={() => { setEditingId(loc.id); setEditingName(loc.name); }} className="h-6 text-[11px] gap-1 rounded-lg px-2.5 text-muted-foreground"><Pencil size={10} />Edit</Button>}
              <Button size="sm" variant="ghost" onClick={() => void toggleActive(loc)} disabled={saving[loc.id]} className="h-6 text-[11px] gap-1 rounded-lg px-2.5 text-muted-foreground">
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
  sku: string | null;
  merchantSku: string | null;
  locationName: string;
  locationType: string;
};

function StockGridTab({ getToken }: { getToken: () => Promise<string | null> }) {
  const [balances, setBalances] = useState<InventoryBalance[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterLoc, setFilterLoc] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [detailId, setDetailId] = useState<number | null>(null);

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
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Network error"); }
    finally { setLoading(false); }
  }, [getToken, filterLoc]);

  useEffect(() => { fetchBalances(); }, [fetchBalances]);

  // Group by product for the grid view
  const productMap = new Map<number, { name: string; sku: string | null; balances: InventoryBalance[] }>();
  for (const b of balances) {
    if (!productMap.has(b.productId)) {
      productMap.set(b.productId, { name: b.alavontName ?? b.productName, sku: b.sku ?? b.merchantSku, balances: [] });
    }
    productMap.get(b.productId)!.balances.push(b);
  }
  const products = Array.from(productMap.entries())
    .filter(([, product]) => `${product.name} ${product.sku ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

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
      {detailId != null && <InventoryLedgerDetail getToken={getToken} entityType="catalog" itemId={detailId} onClose={() => setDetailId(null)} onChanged={() => { void fetchBalances(); }} />}
      <div className="flex flex-wrap items-end gap-3">
        <p className="text-xs text-muted-foreground flex-1">
          Catalogue inventory uses the same tenant-scoped, server-authoritative balances as checkout. Use an item’s actions to create an immutable receipt, transfer, adjustment, or loss movement.
        </p>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">
            <span className="mb-1 block">Search catalogue inventory</span>
            <Input aria-label="Search catalogue inventory" value={search} onChange={e => setSearch(e.target.value)} placeholder="Product name" className="h-8 w-52" />
          </label>
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
            style={{ gridTemplateColumns: `minmax(180px, 1fr) repeat(${Math.max(activeLocations.length, 1)}, 100px) 80px` }}>
            <div>Catalogue item</div>
            {activeLocations.map(l => (
              <div key={l.id} className="text-center">
                {l.name}
                <span className="block text-[9px] font-medium normal-case tracking-normal">{inventoryLocationRoleLabel(l)}</span>
                <span className="block text-[9px] font-medium normal-case tracking-normal opacity-70">Qty / Par</span>
              </div>
            ))}
            <div className="text-center">Total</div>
          </div>

          {/* Rows */}
          {products.map(([productId, { name, sku, balances: pBalances }]) => (
              <div key={productId}
              className="grid gap-2 px-4 py-2 border-b border-border/20 last:border-0 hover:bg-muted/10 transition-colors items-center"
              style={{ gridTemplateColumns: `minmax(180px, 1fr) repeat(${Math.max(activeLocations.length, 1)}, 100px) 80px` }}>
              <div className="flex items-center gap-2 text-xs font-medium min-w-0"><div className="min-w-0 flex-1"><div className="truncate">{name}</div><div className="mt-1 flex flex-wrap items-center gap-1"><Badge variant="outline" className="text-[9px]">Catalogue</Badge>{sku && <span className="font-mono text-[9px] text-muted-foreground">SKU {sku}</span>}</div></div><Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => setDetailId(productId)}>Open</Button></div>
              {activeLocations.map(loc => {
                const b = pBalances.find(pb => pb.locationId === loc.id);
                if (!b) return <div key={loc.id} className="text-center text-muted-foreground/30 text-xs">—</div>;
                return (
                  <div key={loc.id} className="text-center text-xs font-mono" title={`${loc.name}: on hand ${b.quantityOnHand}; PAR ${b.parLevel}`}>
                    <div>{b.quantityOnHand}</div><div className="text-[9px] text-muted-foreground">PAR {b.parLevel}</div>
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
      {products.length === 0 && balances.length > 0 && <div className="rounded-xl border border-dashed border-border/40 p-8 text-center text-xs text-muted-foreground">No catalogue inventory matches “{search}”.</div>}
    </div>
  );
}


// ─── Inventory Health Tab ────────────────────────────────────────────────────

function InventoryHealthTab({ getToken }: { getToken: () => Promise<string | null> }) {
  const [report, setReport] = useState<InventoryHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/inventory/health", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("Failed to load inventory health report");
      setReport(await res.json() as InventoryHealthResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { void fetchHealth(); }, [fetchHealth]);

  async function postAction(id: number, path: string, body: unknown) {
    setBusyId(id);
    try {
      const token = await getToken();
      const res = await fetch(`/api/admin/inventory/balances/${id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Inventory health action failed");
      await fetchHealth();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Inventory health action failed");
    } finally {
      setBusyId(null);
    }
  }

  const rows = report?.rows.filter(row => row.classification !== "sellable_catalog_product" || row.quarantinedAt || row.inventoryKind === "non_sellable_supply") ?? [];

  if (loading) return <div className="flex items-center justify-center py-20"><RefreshCw size={20} className="animate-spin text-muted-foreground" /></div>;
  if (error) return <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 p-4 text-sm">{error}</div>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {report && Object.entries(report.summary).map(([key, value]) => (
          <div key={key} className="rounded-xl border border-border/40 bg-card/60 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{key.replaceAll("_", " ")}</div>
            <div className="text-xl font-bold mt-1">{value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border/40 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">Balance</th>
              <th className="text-left px-3 py-2">Classification</th>
              <th className="text-left px-3 py-2">Product / Location</th>
              <th className="text-right px-3 py-2">Qty</th>
              <th className="text-right px-3 py-2">Par</th>
              <th className="text-left px-3 py-2">Quarantine</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} className="border-t border-border/30">
                <td className="px-3 py-2 font-mono">#{row.id}<div className="text-muted-foreground">tenant {row.tenantId}</div></td>
                <td className="px-3 py-2"><Badge variant="outline">{row.classification.replaceAll("_", " ")}</Badge></td>
                <td className="px-3 py-2">
                  <div>{row.productName ?? `Missing product #${row.productId}`}</div>
                  <div className="text-muted-foreground">{row.locationName ?? `Missing location #${row.locationId}`}</div>
                </td>
                <td className="px-3 py-2 text-right font-mono">{row.quantityOnHand}</td>
                <td className="px-3 py-2 text-right font-mono">{row.parLevel}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.quarantinedAt ? new Date(row.quarantinedAt).toLocaleString() : "—"}</td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" disabled={busyId === row.id || Boolean(row.quarantinedAt)} onClick={() => postAction(row.id, "quarantine", { reason: "Quarantined from Inventory Health UI" })}>Quarantine</Button>
                    <Button size="sm" variant="outline" disabled={busyId === row.id || row.inventoryKind === "non_sellable_supply"} onClick={() => postAction(row.id, "classify", { inventoryKind: "non_sellable_supply" })}>Supply</Button>
                    <Button size="sm" variant="outline" disabled={busyId === row.id || (row.inventoryKind === "sellable" && row.isSellable)} onClick={() => postAction(row.id, "classify", { inventoryKind: "sellable" })}>Restore</Button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="text-center text-muted-foreground py-8">No orphan, invalid, quarantined, or non-sellable supply balances found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type NonCatalogSection = { id: number; name: string; isActive: boolean };
type NonCatalogItem = { id: number; sectionId: number | null; name: string; description: string | null; sku: string | null; barcode: string | null; unitOfMeasure: string; parLevel: string | number; moq: string | number; preferredReorderQuantity: string | number; unitCost: string | number | null; supplier: string | null; supplierSku: string | null; notes: string | null; isActive: boolean };
type NonCatalogBalance = { id: number; itemId: number; locationId: number; quantityOnHand: string | number };
type LedgerDetail = { item: { id: number; name: string; quantityOnHand: string | number; currentDefaultCost: string | number | null; lastPurchaseCost: string | number | null; weightedAverageCost: string | number | null; inventoryValue: string | number | null; costStatus: "known" | "unknown_baseline" }; purchaseHistory: LedgerMovement[]; movementHistory: LedgerMovement[] };
type LedgerMovement = { id: number; createdAt: string; movementType: string; quantityDelta: string | number; unitCost: string | number | null; extendedCost: string | number | null; supplierReference: string | null; sourceType: string; sourceId: string | null; orderId: number | null; receiptId: number | null; reasonCode: string | null; locationName: string };
// /api/admin/inventory is the tenant-scoped selectable-location source. It
// already returns active locations only, so its compact metadata deliberately
// does not include isActive.
type NonCatalogLocation = { id: number; name: string; type: string };
type NonCatalogForm = { name: string; description: string; sectionId: string; sku: string; barcode: string; unitOfMeasure: string; parLevel: string; moq: string; preferredReorderQuantity: string; unitCost: string; supplier: string; supplierSku: string; notes: string };
const emptyNonCatalogForm = (): NonCatalogForm => ({ name: "", description: "", sectionId: "", sku: "", barcode: "", unitOfMeasure: "each", parLevel: "0", moq: "0", preferredReorderQuantity: "0", unitCost: "", supplier: "", supplierSku: "", notes: "" });

function InventoryLedgerDetail({ getToken, entityType, itemId, onClose, onChanged }: { getToken: () => Promise<string | null>; entityType: "catalog" | "non_catalog"; itemId: number; onClose: () => void; onChanged?: () => void }) {
  const [detail, setDetail] = useState<LedgerDetail | null>(null); const [error, setError] = useState<string | null>(null);
  const [locations, setLocations] = useState<NonCatalogLocation[]>([]); const [action, setAction] = useState<"receipt" | "transfer" | "loss" | "adjustment" | null>(null); const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ locationId: "", destinationLocationId: "", quantity: "", unitCost: "", supplierReference: "", reason: "", movementType: "waste", direction: "decrease" });
  const load = useCallback(async () => { const token = await getToken(); const headers: Record<string, string> = {}; if (token) headers.Authorization = `Bearer ${token}`; const [detailResponse, locationsResponse] = await Promise.all([fetch(`/api/admin/inventory/${entityType}/${itemId}/detail`, { headers }), fetch("/api/admin/inventory", { headers })]); if (!detailResponse.ok) throw new Error("Could not load inventory valuation"); const data = await detailResponse.json() as LedgerDetail; setDetail(data); if (locationsResponse.ok) setLocations(((await locationsResponse.json()).locations ?? []) as NonCatalogLocation[]); }, [entityType, getToken, itemId]);
  useEffect(() => { let active = true; void load().catch(e => { if (active) setError(e instanceof Error ? e.message : "Could not load inventory valuation"); }); return () => { active = false; }; }, [load]);
  const submit = async () => { if (!action || !form.locationId || !form.quantity) return; setBusy(true); setError(null); try { const token = await getToken(); const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }; const key = globalThis.crypto?.randomUUID?.() ?? `inventory-${Date.now()}`; let path = "/api/admin/inventory/movements"; let body: Record<string, unknown> = { entityType, itemId, locationId: Number(form.locationId), quantity: form.quantity, idempotencyKey: key, reasonText: form.reason || undefined, reasonCode: form.reason || action };
      if (action === "receipt") { path = "/api/admin/inventory/receipts"; body = { entityType, itemId, locationId: Number(form.locationId), quantity: form.quantity, unitCost: form.unitCost, supplierReference: form.supplierReference || undefined, reference: form.reason || undefined, idempotencyKey: key }; }
      else if (action === "transfer") { path = "/api/admin/inventory/transfers"; body = { entityType, itemId, sourceLocationId: Number(form.locationId), destinationLocationId: Number(form.destinationLocationId), quantity: form.quantity, reasonText: form.reason || undefined, idempotencyKey: key }; }
      else if (action === "loss") body.movementType = form.movementType;
      else { body.movementType = form.direction === "increase" ? "adjustment_increase" : "adjustment_decrease"; if (form.direction === "increase" && form.unitCost) body.unitCost = form.unitCost; }
      const response = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) }); const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error ?? `Inventory action failed (${response.status})`); setAction(null); setForm({ locationId: "", destinationLocationId: "", quantity: "", unitCost: "", supplierReference: "", reason: "", movementType: "waste", direction: "decrease" }); await load(); onChanged?.(); } catch (e) { setError(e instanceof Error ? e.message : "Inventory action failed"); } finally { setBusy(false); } };
  const money = (value: string | number | null) => value == null ? (detail?.item.costStatus === "unknown_baseline" ? "Unknown baseline" : "—") : `$${Number(value).toFixed(2)}`;
  const reference = (row: LedgerMovement) => row.receiptId ? `Receipt #${row.receiptId}` : row.orderId ? `Order #${row.orderId}` : row.sourceId ? `${row.sourceType} ${row.sourceId}` : row.sourceType;
  if (error) return <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>;
  if (!detail) return <div className="rounded-xl border border-border/40 p-4 text-sm text-muted-foreground"><Loader2 size={14} className="mr-2 inline animate-spin" />Loading valuation…</div>;
  return <section className="rounded-xl border border-primary/30 bg-card/60 p-4 space-y-4" aria-label="Inventory valuation detail"><div className="flex items-center justify-between"><div><h2 className="font-semibold">{detail.item.name} — inventory detail</h2><p className="text-xs text-muted-foreground">Internal valuation and immutable movement history.</p></div><Button size="sm" variant="ghost" onClick={onClose}>Close</Button></div><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => setAction("receipt")}>Receive</Button><Button size="sm" variant="outline" onClick={() => setAction("transfer")}>Transfer</Button><Button size="sm" variant="outline" onClick={() => setAction("loss")}>Record Loss</Button><Button size="sm" variant="outline" onClick={() => setAction("adjustment")}>Adjust</Button></div>{error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-400">{error}</div>}{action && <div className="rounded-lg border border-border/40 bg-muted/10 p-3 space-y-3"><div className="font-semibold text-sm">{action === "receipt" ? "Receive inventory" : action === "transfer" ? "Transfer inventory" : action === "loss" ? "Record loss" : "Adjust inventory"}</div><div className="grid gap-2 md:grid-cols-3"><label className="text-xs text-muted-foreground">Location<select aria-label="Location" className="mt-1 h-8 w-full rounded border bg-background px-2" value={form.locationId} onChange={e => setForm(v => ({ ...v, locationId: e.target.value }))}><option value="">Choose location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>{action === "transfer" && <label className="text-xs text-muted-foreground">To location<select aria-label="To location" className="mt-1 h-8 w-full rounded border bg-background px-2" value={form.destinationLocationId} onChange={e => setForm(v => ({ ...v, destinationLocationId: e.target.value }))}><option value="">Choose destination</option>{locations.filter(l => String(l.id) !== form.locationId).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}<label className="text-xs text-muted-foreground">Quantity<Input aria-label="Quantity" className="mt-1 h-8" value={form.quantity} onChange={e => setForm(v => ({ ...v, quantity: e.target.value }))} /></label>{action === "receipt" && <label className="text-xs text-muted-foreground">Actual unit cost<Input aria-label="Actual unit cost" className="mt-1 h-8" value={form.unitCost} onChange={e => setForm(v => ({ ...v, unitCost: e.target.value }))} /></label>}{action === "receipt" && <label className="text-xs text-muted-foreground">Supplier / reference<Input aria-label="Supplier / reference" className="mt-1 h-8" value={form.supplierReference} onChange={e => setForm(v => ({ ...v, supplierReference: e.target.value }))} /></label>}{action === "loss" && <label className="text-xs text-muted-foreground">Type<select aria-label="Loss type" className="mt-1 h-8 w-full rounded border bg-background px-2" value={form.movementType} onChange={e => setForm(v => ({ ...v, movementType: e.target.value }))}><option value="waste">Waste</option><option value="damage">Damage</option><option value="shrinkage">Shrinkage</option></select></label>}{action === "adjustment" && <label className="text-xs text-muted-foreground">Direction<select aria-label="Adjustment direction" className="mt-1 h-8 w-full rounded border bg-background px-2" value={form.direction} onChange={e => setForm(v => ({ ...v, direction: e.target.value }))}><option value="decrease">Decrease</option><option value="increase">Increase</option></select></label>}{action !== "receipt" && <label className="text-xs text-muted-foreground">Reason<Input aria-label="Reason" className="mt-1 h-8" value={form.reason} onChange={e => setForm(v => ({ ...v, reason: e.target.value }))} /></label>}</div><div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setAction(null)}>Cancel</Button><Button size="sm" disabled={busy || !form.locationId || !form.quantity || (action === "receipt" && !form.unitCost) || (action === "transfer" && !form.destinationLocationId)} onClick={() => void submit()}>{busy ? <Loader2 size={12} className="animate-spin" /> : "Save movement"}</Button></div></div>}<div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5"><div><div className="text-xs text-muted-foreground">Quantity</div><div className="font-semibold">{detail.item.quantityOnHand}</div></div><div><div className="text-xs text-muted-foreground">Current Supplier Cost</div><div className="font-semibold">{money(detail.item.currentDefaultCost)}</div></div><div><div className="text-xs text-muted-foreground">Last Purchase Cost</div><div className="font-semibold">{money(detail.item.lastPurchaseCost)}</div></div><div><div className="text-xs text-muted-foreground">Weighted Average Cost</div><div className="font-semibold">{money(detail.item.weightedAverageCost)}</div></div><div><div className="text-xs text-muted-foreground">Inventory Value</div><div className="font-semibold">{money(detail.item.inventoryValue)}</div></div></div><LedgerRows title="Purchase History" rows={detail.purchaseHistory} reference={reference} /><LedgerRows title="Movement History" rows={detail.movementHistory} reference={reference} /></section>;
}

function LedgerRows({ title, rows, reference }: { title: string; rows: LedgerMovement[]; reference: (row: LedgerMovement) => string }) {
  return <div><h3 className="mb-2 text-sm font-semibold">{title}</h3><div className="overflow-x-auto rounded-lg border border-border/40"><table className="w-full text-xs"><thead className="bg-muted/30 text-muted-foreground"><tr><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-left">Type</th><th className="px-2 py-1 text-right">Quantity</th><th className="px-2 py-1 text-left">Location</th><th className="px-2 py-1 text-right">Cost impact</th><th className="px-2 py-1 text-left">Reference</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-t border-border/30"><td className="px-2 py-1">{new Date(row.createdAt).toLocaleDateString()}</td><td className="px-2 py-1">{row.movementType}</td><td className="px-2 py-1 text-right font-mono">{row.quantityDelta}</td><td className="px-2 py-1">{row.locationName}</td><td className="px-2 py-1 text-right font-mono">{row.extendedCost == null ? "—" : `$${Number(row.extendedCost).toFixed(2)}`}</td><td className="px-2 py-1">{reference(row)}{row.supplierReference ? ` · ${row.supplierReference}` : ""}</td></tr>)}{rows.length === 0 && <tr><td colSpan={6} className="px-2 py-4 text-center text-muted-foreground">No records yet.</td></tr>}</tbody></table></div></div>;
}

function NonCatalogTab({ getToken }: { getToken: () => Promise<string | null> }) {
  const [sections, setSections] = useState<NonCatalogSection[]>([]); const [items, setItems] = useState<NonCatalogItem[]>([]); const [balances, setBalances] = useState<NonCatalogBalance[]>([]); const [locations, setLocations] = useState<NonCatalogLocation[]>([]);
  const [sectionName, setSectionName] = useState(""); const [sectionEditing, setSectionEditing] = useState<number | null>(null); const [sectionEditName, setSectionEditName] = useState(""); const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [form, setForm] = useState<NonCatalogForm>(emptyNonCatalogForm); const [editingId, setEditingId] = useState<number | null>(null); const [search, setSearch] = useState(""); const [sectionFilter, setSectionFilter] = useState("all"); const [locationId, setLocationId] = useState(""); const [stockFilter, setStockFilter] = useState("all"); const [showArchived, setShowArchived] = useState(false);
  const [adjustItemId, setAdjustItemId] = useState<number | null>(null); const [adjustment, setAdjustment] = useState("0"); const [adjustmentReason, setAdjustmentReason] = useState<"INITIAL" | "ADJUSTMENT">("INITIAL"); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [detailItemId, setDetailItemId] = useState<number | null>(null);
  const headers = useCallback(async () => { const token = await getToken(); return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }; }, [getToken]);
  const request = useCallback(async (path: string, init?: RequestInit) => { const response = await fetch(path, { ...init, headers: { ...(await headers()), ...(init?.headers ?? {}) } }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? `Request failed (${response.status})`); } return response.json().catch(() => ({})); }, [headers]);
  const load = useCallback(async () => { const [s, i, b, inventory] = await Promise.all([request("/api/admin/non-catalog/sections"), request("/api/admin/non-catalog/items"), request("/api/admin/non-catalog/balances"), request("/api/admin/inventory")]); setSections(s.sections ?? []); setItems(i.items ?? []); setBalances(b.balances ?? []); setLocations((inventory.locations ?? []) as NonCatalogLocation[]); }, [request]);
  useEffect(() => { void load().catch(e => setError(e instanceof Error ? e.message : "Load failed")); }, [load]);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(null); try { await work(); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Inventory action failed"); } finally { setBusy(false); } };
  const n = (value: string | number | null | undefined) => Number(value ?? 0);
  const formPayload = () => ({ name: form.name.trim(), description: form.description || null, sectionId: form.sectionId ? Number(form.sectionId) : null, sku: form.sku || null, barcode: form.barcode || null, unitOfMeasure: form.unitOfMeasure.trim(), parLevel: n(form.parLevel), moq: n(form.moq), preferredReorderQuantity: n(form.preferredReorderQuantity), unitCost: form.unitCost === "" ? null : n(form.unitCost), supplier: form.supplier || null, supplierSku: form.supplierSku || null, notes: form.notes || null });
  const beginEdit = (item: NonCatalogItem) => { setEditingId(item.id); setForm({ name: item.name, description: item.description ?? "", sectionId: item.sectionId?.toString() ?? "", sku: item.sku ?? "", barcode: item.barcode ?? "", unitOfMeasure: item.unitOfMeasure, parLevel: String(item.parLevel), moq: String(item.moq), preferredReorderQuantity: String(item.preferredReorderQuantity), unitCost: item.unitCost == null ? "" : String(item.unitCost), supplier: item.supplier ?? "", supplierSku: item.supplierSku ?? "", notes: item.notes ?? "" }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const balanceFor = (itemId: number) => balances.find(balance => balance.itemId === itemId && balance.locationId === Number(locationId));
  const stockFor = (itemId: number) => n(balanceFor(itemId)?.quantityOnHand);
  const effectivePar = (item: NonCatalogItem) => n(item.parLevel);
  const filteredItems = items.filter(item => { const quantity = locationId ? stockFor(item.id) : balances.filter(balance => balance.itemId === item.id).reduce((sum, balance) => sum + n(balance.quantityOnHand), 0); const matchText = `${item.name} ${item.sku ?? ""} ${item.barcode ?? ""} ${item.supplier ?? ""}`.toLowerCase().includes(search.toLowerCase()); const matchSection = sectionFilter === "all" || item.sectionId === Number(sectionFilter); const matchState = stockFilter === "all" || (stockFilter === "low" && quantity < effectivePar(item)) || (stockFilter === "out" && quantity <= 0); return matchText && matchSection && matchState && (showArchived || item.isActive); });
  const updateField = (key: keyof NonCatalogForm, value: string) => setForm(current => ({ ...current, [key]: value }));
  const input = (label: string, key: keyof NonCatalogForm, type = "text") => <label className="text-xs text-muted-foreground"><span className="mb-1 block">{label}</span><Input type={type} value={form[key]} onChange={event => updateField(key, event.target.value)} /></label>;
  return <div className="space-y-4">
    <div className="rounded-xl border border-border/40 bg-card/50 p-4 space-y-3"><div className="flex flex-wrap items-end gap-3"><label className="min-w-52 flex-1 text-xs text-muted-foreground"><span className="mb-1 flex items-center gap-1"><Search size={12} /> Search</span><Input placeholder="Name, SKU, barcode, supplier" value={search} onChange={event => setSearch(event.target.value)} /></label><label className="text-xs text-muted-foreground"><span className="mb-1 block">Section</span><select className="h-9 rounded-md border bg-background px-2" value={sectionFilter} onChange={event => setSectionFilter(event.target.value)}><option value="all">All sections</option>{sections.filter(section => section.isActive).map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label><label className="text-xs text-muted-foreground"><span className="mb-1 block">Location</span><select className="h-9 rounded-md border bg-background px-2" value={locationId} onChange={event => setLocationId(event.target.value)}><option value="">All locations</option>{locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label className="text-xs text-muted-foreground"><span className="mb-1 block">Stock state</span><select className="h-9 rounded-md border bg-background px-2" value={stockFilter} onChange={event => setStockFilter(event.target.value)}><option value="all">All stock</option><option value="low">Low stock</option><option value="out">Out of stock</option></select></label><label className="text-xs text-muted-foreground"><span className="mb-1 block">Inventory type</span><select className="h-9 rounded-md border bg-background px-2" value="non-catalog" aria-label="Inventory type"><option value="non-catalog">Non-Catalog</option></select></label><label className="flex items-center gap-2 pb-2 text-xs"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} /> Show archived</label></div><p className="text-xs text-muted-foreground">Low stock uses item PAR at the selected location (or total stock when no location is selected). MOQ informs purchasing only.</p></div>
    {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}
    <div className="rounded-xl border border-border/40 p-4 space-y-3"><div className="flex items-center justify-between"><h2 className="font-semibold">{editingId ? "Edit non-catalog item" : "Create non-catalog item"}</h2>{editingId && <Button size="sm" variant="outline" onClick={() => { setEditingId(null); setForm(emptyNonCatalogForm()); }}>Cancel edit</Button>}</div><div className="grid gap-3 md:grid-cols-3">{input("Name", "name")}{input("Description", "description")}<label className="text-xs text-muted-foreground"><span className="mb-1 block">Section</span><select className="h-9 w-full rounded-md border bg-background px-2" value={form.sectionId} onChange={event => updateField("sectionId", event.target.value)}><option value="">Unsectioned</option>{sections.filter(section => section.isActive).map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>{input("Internal SKU", "sku")}{input("Barcode", "barcode")}{input("Unit", "unitOfMeasure")}{input("PAR", "parLevel", "number")}{input("Minimum Order Quantity", "moq", "number")}{input("Preferred Reorder Quantity", "preferredReorderQuantity", "number")}{input("Supplier", "supplier")}{input("Supplier SKU", "supplierSku")}{input("Unit Cost", "unitCost", "number")}<label className="text-xs text-muted-foreground md:col-span-3"><span className="mb-1 block">Notes</span><textarea className="min-h-20 w-full rounded-md border bg-background p-2 text-sm" value={form.notes} onChange={event => updateField("notes", event.target.value)} /></label></div><Button disabled={busy || !form.name.trim()} onClick={() => void run(async () => { await request(editingId ? `/api/admin/non-catalog/items/${editingId}` : "/api/admin/non-catalog/items", { method: editingId ? "PATCH" : "POST", body: JSON.stringify(formPayload()) }); setEditingId(null); setForm(emptyNonCatalogForm()); })}>{editingId ? <Pencil size={14} /> : <Plus size={14} />}{editingId ? "Save item" : "Create item"}</Button></div>
    <div className="rounded-xl border border-border/40 p-4"><div className="mb-3 flex flex-wrap items-end gap-2"><label className="flex-1 text-xs text-muted-foreground"><span className="mb-1 block">New section</span><Input value={sectionName} onChange={event => setSectionName(event.target.value)} placeholder="e.g. Shipping Supplies" /></label><Button disabled={busy || !sectionName.trim()} onClick={() => void run(async () => { await request("/api/admin/non-catalog/sections", { method: "POST", body: JSON.stringify({ name: sectionName.trim() }) }); setSectionName(""); })}><Plus size={14} /> Create section</Button></div>{sections.filter(section => section.isActive).map(section => { const sectionItems = filteredItems.filter(item => item.sectionId === section.id); const open = expanded[section.id] !== false; return <div key={section.id} className="border-t border-border/40 py-3"><div className="flex flex-wrap items-center gap-2"><button aria-label={`${open ? "Collapse" : "Expand"} ${section.name}`} className="flex flex-1 items-center gap-2 text-left font-bold" onClick={() => setExpanded(current => ({ ...current, [section.id]: !open }))}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}{section.name} <span className="text-xs font-normal text-muted-foreground">({sectionItems.length})</span></button>{sectionEditing === section.id ? <><Input className="w-52" value={sectionEditName} onChange={event => setSectionEditName(event.target.value)} /><Button size="sm" disabled={busy || !sectionEditName.trim()} onClick={() => void run(async () => { await request(`/api/admin/non-catalog/sections/${section.id}`, { method: "PATCH", body: JSON.stringify({ name: sectionEditName.trim() }) }); setSectionEditing(null); })}>Save</Button></> : <Button aria-label={`Rename ${section.name}`} size="sm" variant="ghost" onClick={() => { setSectionEditing(section.id); setSectionEditName(section.name); }}><Pencil size={14} /> Rename</Button>}<Button aria-label={`Archive ${section.name}`} size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { await request(`/api/admin/non-catalog/sections/${section.id}`, { method: "DELETE" }); })}><Archive size={14} /> Archive</Button></div>{open && <div className="mt-2 space-y-2">{sectionItems.map(item => <NonCatalogItemRow key={item.id} item={item} quantity={locationId ? stockFor(item.id) : balances.filter(balance => balance.itemId === item.id).reduce((sum, balance) => sum + n(balance.quantityOnHand), 0)} effectivePar={effectivePar(item)} locationName={locations.find(location => location.id === Number(locationId))?.name} onDetail={() => setDetailItemId(item.id)} onEdit={() => beginEdit(item)} onArchive={() => void run(async () => { await request(`/api/admin/non-catalog/items/${item.id}`, { method: "DELETE" }); })} onAdjust={() => { setAdjustItemId(item.id); setAdjustment("0"); setAdjustmentReason(stockFor(item.id) === 0 ? "INITIAL" : "ADJUSTMENT"); }} />)}{sectionItems.length === 0 && <div className="px-6 py-2 text-sm text-muted-foreground">No matching active items.</div>}</div>}</div>; })}{filteredItems.filter(item => item.sectionId == null).length > 0 && <div className="border-t border-border/40 py-3"><div className="font-bold">Unsectioned</div>{filteredItems.filter(item => item.sectionId == null).map(item => <NonCatalogItemRow key={item.id} item={item} quantity={locationId ? stockFor(item.id) : balances.filter(balance => balance.itemId === item.id).reduce((sum, balance) => sum + n(balance.quantityOnHand), 0)} effectivePar={effectivePar(item)} onDetail={() => setDetailItemId(item.id)} onEdit={() => beginEdit(item)} onArchive={() => void run(async () => { await request(`/api/admin/non-catalog/items/${item.id}`, { method: "DELETE" }); })} onAdjust={() => { setAdjustItemId(item.id); setAdjustment("0"); }} />)}</div>}{sections.filter(section => section.isActive).length === 0 && <div className="text-sm text-muted-foreground">Create a section to organize non-catalog stock.</div>}</div>
    {adjustItemId != null && <div className="rounded-xl border border-primary/30 bg-primary/5 p-4"><div className="mb-2 font-semibold">Audited stock {adjustmentReason === "INITIAL" ? "initialization" : "adjustment"}: {items.find(item => item.id === adjustItemId)?.name}</div><div className="flex flex-wrap items-end gap-3"><label className="text-xs text-muted-foreground"><span className="mb-1 block">Location</span><select className="h-9 rounded-md border bg-background px-2" value={locationId} onChange={event => setLocationId(event.target.value)}><option value="">Choose location</option>{locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label className="text-xs text-muted-foreground"><span className="mb-1 block">Action</span><select className="h-9 rounded-md border bg-background px-2" value={adjustmentReason} onChange={event => setAdjustmentReason(event.target.value as "INITIAL" | "ADJUSTMENT")}><option value="INITIAL">Initialize stock</option><option value="ADJUSTMENT">Adjustment (+/-)</option></select></label><label className="text-xs text-muted-foreground"><span className="mb-1 block">{adjustmentReason === "INITIAL" ? "Starting quantity" : "Quantity change"}</span><Input type="number" value={adjustment} onChange={event => setAdjustment(event.target.value)} /></label><Button disabled={busy || !locationId || !Number.isFinite(Number(adjustment))} onClick={() => void run(async () => { const key = globalThis.crypto?.randomUUID?.() ?? `noncatalog-${Date.now()}-${adjustItemId}`; await request("/api/admin/non-catalog/balances/adjust", { method: "POST", body: JSON.stringify({ itemId: adjustItemId, locationId: Number(locationId), quantityDelta: Number(adjustment), reason: adjustmentReason, idempotencyKey: key }) }); setAdjustItemId(null); })}>Save audited movement</Button><Button variant="ghost" onClick={() => setAdjustItemId(null)}>Cancel</Button></div></div>}
    {detailItemId != null && <InventoryLedgerDetail getToken={getToken} entityType="non_catalog" itemId={detailItemId} onClose={() => setDetailItemId(null)} onChanged={() => { void load(); }} />}
  </div>;
}

function NonCatalogItemRow({ item, quantity, effectivePar, locationName, onEdit, onArchive, onAdjust, onDetail }: { item: NonCatalogItem; quantity: number; effectivePar: number; locationName?: string; onEdit: () => void; onArchive: () => void; onAdjust: () => void; onDetail: () => void }) {
  const state = quantity <= 0 ? "Out of stock" : quantity < effectivePar ? "Low stock" : "In stock";
  return <div className={`rounded-lg border p-3 ${item.isActive ? "border-border/40" : "border-border/20 opacity-60"}`}><div className="flex flex-wrap items-start gap-3"><div className="min-w-48 flex-1"><div className="font-bold">{item.name}{!item.isActive && <span className="ml-2 text-xs font-normal text-muted-foreground">Archived</span>}</div><div className="mt-1 text-xs text-muted-foreground">{item.description || "No description"}{item.sku && ` · SKU ${item.sku}`}{item.barcode && ` · Barcode ${item.barcode}`}</div><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs"><span className="font-semibold">PAR {effectivePar}</span><span className="font-semibold">Minimum Order {item.moq}</span><span className="text-muted-foreground">Preferred reorder {item.preferredReorderQuantity}</span><span className="text-muted-foreground">{item.unitOfMeasure}{item.supplier && ` · ${item.supplier}`}{item.supplierSku && ` / ${item.supplierSku}`}{item.unitCost != null && ` · $${item.unitCost}`}</span></div></div><div className="min-w-28 text-right"><div className="text-[10px] uppercase text-muted-foreground">Stock{locationName ? ` · ${locationName}` : ""}</div><div className="text-xl font-bold">{quantity}</div><div className={`text-xs ${state === "In stock" ? "text-muted-foreground" : "text-amber-500"}`}>{state}</div></div><div className="flex gap-1"><Button size="sm" variant="outline" onClick={onAdjust} disabled={!item.isActive}>Stock</Button><Button size="sm" variant="outline" onClick={onDetail}>Details</Button><Button aria-label={`Edit ${item.name}`} size="sm" variant="ghost" onClick={onEdit}><Pencil size={14} /></Button><Button aria-label={`Archive ${item.name}`} size="sm" variant="ghost" onClick={onArchive} disabled={!item.isActive}><Archive size={14} /></Button></div></div></div>;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminInventory() {
  const { getToken } = useAuth();
  const [tab, setTab] = useState<"template" | "locations" | "stockgrid" | "health" | "noncatalog">("stockgrid");

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
          { key: "stockgrid" as const, label: "All Inventory", icon: ClipboardList },
          { key: "noncatalog" as const, label: "Non-Catalog", icon: Package },
          { key: "locations" as const, label: "Locations", icon: MapPin },
          { key: "template" as const, label: "Shift Template", icon: Settings2 },
          { key: "health" as const, label: "Health", icon: EyeOff },
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
      ) : tab === "locations" ? (
        <LocationsTab getToken={getToken} />
      ) : tab === "stockgrid" ? (
        <StockGridTab getToken={getToken} />
      ) : tab === "health" ? (
        <InventoryHealthTab getToken={getToken} />
      ) : tab === "noncatalog" ? (
        <NonCatalogTab getToken={getToken} />
      ) : null}
    </div>
  );
}
