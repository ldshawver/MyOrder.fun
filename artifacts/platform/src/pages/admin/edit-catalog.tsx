import { useState, useCallback } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Edit2, Trash2, Search, RefreshCw, Loader2, FlaskConical, Link2,
  Globe, Tag, Image, CheckCircle, XCircle, Package, X, Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// ─── Types ─────────────────────────────────────────────────────────────────────

type CatalogProduct = {
  id: number;
  name: string;
  alavontName: string | null;
  luciferCruzName: string | null;
  luciferCruzCategory: string | null;
  luciferCruzDescription: string | null;
  luciferCruzImageUrl: string | null;
  alavontCategory: string | null;
  category: string;
  description: string | null;
  alavontDescription: string | null;
  price: number;
  regularPrice: number | null;
  compareAtPrice: number | null;
  imageUrl: string | null;
  alavontImageUrl: string | null;
  isAvailable: boolean;
  isWooManaged: boolean;
  isLocalAlavont: boolean;
  sku: string | null;
  alavontInStock: boolean | null;
  labName: string | null;
  stockQuantity: number | null;
};

const EMPTY_FORM: Partial<CatalogProduct> & { price: number; isAvailable: boolean; isWooManaged: boolean } = {
  name: "",
  alavontName: "",
  luciferCruzName: "",
  category: "",
  alavontCategory: "",
  description: "",
  alavontDescription: "",
  price: 0,
  regularPrice: null,
  imageUrl: "",
  alavontImageUrl: "",
  luciferCruzImageUrl: "",
  luciferCruzDescription: "",
  luciferCruzCategory: "",
  labName: "",
  isAvailable: true,
  isWooManaged: false,
};

function fieldVal(v: unknown): string {
  return v == null ? "" : String(v);
}

// ─── Edit Dialog ───────────────────────────────────────────────────────────────

function EditDialog({
  item,
  onClose,
  onSave,
  isSaving,
}: {
  item: Partial<CatalogProduct> | null;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
  isSaving: boolean;
}) {
  const isNew = !item?.id;
  const isWoo = item?.isWooManaged === true;

  const [form, setForm] = useState<Record<string, string | boolean | number>>({
    name: fieldVal(item?.name),
    alavontName: fieldVal(item?.alavontName),
    luciferCruzName: fieldVal(item?.luciferCruzName),
    category: fieldVal(item?.category),
    alavontCategory: fieldVal(item?.alavontCategory),
    luciferCruzCategory: fieldVal(item?.luciferCruzCategory),
    description: fieldVal(item?.description),
    alavontDescription: fieldVal(item?.alavontDescription),
    luciferCruzDescription: fieldVal(item?.luciferCruzDescription),
    price: fieldVal(item?.price),
    regularPrice: fieldVal(item?.regularPrice),
    imageUrl: fieldVal(item?.imageUrl),
    alavontImageUrl: fieldVal(item?.alavontImageUrl),
    luciferCruzImageUrl: fieldVal(item?.luciferCruzImageUrl),
    labName: fieldVal(item?.labName),
    sku: fieldVal(item?.sku),
    isAvailable: item?.isAvailable !== false,
  });

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  function handleSave() {
    const payload: Record<string, unknown> = {
      name: form.name || form.alavontName || "Unnamed Product",
      alavontName: form.alavontName || null,
      luciferCruzName: form.luciferCruzName || null,
      luciferCruzCategory: form.luciferCruzCategory || null,
      luciferCruzDescription: form.luciferCruzDescription || null,
      luciferCruzImageUrl: form.luciferCruzImageUrl || null,
      category: form.category || form.alavontCategory || "General",
      alavontCategory: form.alavontCategory || null,
      description: form.description || null,
      alavontDescription: form.alavontDescription || null,
      price: parseFloat(String(form.price)) || 0,
      regularPrice: form.regularPrice ? parseFloat(String(form.regularPrice)) : null,
      imageUrl: form.imageUrl || null,
      alavontImageUrl: form.alavontImageUrl || null,
      labName: form.labName || null,
      sku: form.sku || null,
      isAvailable: form.isAvailable,
    };
    onSave(payload);
  }

  const input = (label: string, key: string, disabled = false, type = "text") => (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground font-medium">{label}</span>
      <Input
        type={type}
        value={fieldVal(form[key])}
        onChange={set(key)}
        disabled={disabled || isSaving}
        className="text-sm"
        placeholder={disabled ? "WooCommerce managed" : undefined}
      />
    </label>
  );

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isNew ? <Plus size={16} /> : <Edit2 size={16} />}
            {isNew ? "Add Catalog Product" : `Edit: ${item?.alavontName ?? item?.name}`}
            {isWoo && <Badge variant="outline" className="text-orange-400 border-orange-400/40 text-[10px]">WooCommerce</Badge>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 pt-1">
          {/* Alavont fields */}
          <div>
            <div className="text-xs font-bold uppercase tracking-widest text-blue-400 mb-3 flex items-center gap-1.5">
              <FlaskConical size={11} /> Alavont Therapeutics
            </div>
            <div className="grid grid-cols-2 gap-3">
              {input("Alavont Name", "alavontName", isWoo)}
              {input("Internal Name (base)", "name", isWoo)}
              {input("Alavont Category", "alavontCategory", isWoo)}
              {input("Alavont Image URL", "alavontImageUrl", isWoo)}
              {input("Lab Name / Internal", "labName", isWoo)}
              {input("SKU", "sku")}
              {input("Price ($)", "price", isWoo, "number")}
              {input("Regular / Compare-at Price ($)", "regularPrice", false, "number")}
            </div>
            <label className="flex flex-col gap-1 mt-3">
              <span className="text-xs text-muted-foreground font-medium">Alavont Description</span>
              <textarea
                value={fieldVal(form.alavontDescription)}
                onChange={(e) => setForm(f => ({ ...f, alavontDescription: e.target.value }))}
                disabled={isWoo || isSaving}
                rows={2}
                className="w-full text-sm rounded-md border border-input bg-background px-3 py-2 resize-none"
              />
            </label>
          </div>

          {/* Lucifer Cruz mapping fields */}
          <div>
            <div className="text-xs font-bold uppercase tracking-widest mb-3 flex items-center gap-1.5" style={{ color: "#DC143C" }}>
              <Globe size={11} /> Lucifer Cruz Mapping
            </div>
            <div className="grid grid-cols-2 gap-3">
              {input("LC Display Name", "luciferCruzName")}
              {input("LC Category", "luciferCruzCategory")}
              {input("LC Image URL", "luciferCruzImageUrl")}
              {input("Base Image URL", "imageUrl")}
            </div>
            <label className="flex flex-col gap-1 mt-3">
              <span className="text-xs text-muted-foreground font-medium">LC Description</span>
              <textarea
                value={fieldVal(form.luciferCruzDescription)}
                onChange={(e) => setForm(f => ({ ...f, luciferCruzDescription: e.target.value }))}
                disabled={isSaving}
                rows={2}
                className="w-full text-sm rounded-md border border-input bg-background px-3 py-2 resize-none"
              />
            </label>
          </div>

          {/* Availability */}
          {!isWoo && (
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Availability</div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(form.isAvailable)}
                  onChange={e => setForm(f => ({ ...f, isAvailable: e.target.checked }))}
                  disabled={isSaving}
                  className="w-4 h-4"
                />
                <span className="text-sm">Available for ordering</span>
              </label>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button onClick={handleSave} disabled={isSaving} className="flex-1">
              {isSaving ? <Loader2 size={14} className="animate-spin mr-2" /> : <Save size={14} className="mr-2" />}
              {isNew ? "Create Product" : "Save Changes"}
            </Button>
            <Button variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminEditCatalog() {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showWoo, setShowWoo] = useState(false);
  const [editItem, setEditItem] = useState<Partial<CatalogProduct> | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const fetchCatalog = useCallback(async (): Promise<CatalogProduct[]> => {
    const token = await getToken();
    // Admin mode returns all non-WooManaged products (plus WooManaged when showWoo toggled)
    const r = await fetch("/api/catalog?limit=500&mode=alavont", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    return data.items ?? [];
  }, [getToken]);

  const { data: items = [], isLoading, refetch } = useQuery({
    queryKey: ["edit-catalog"],
    queryFn: fetchCatalog,
    staleTime: 30_000,
  });

  const saveMutation = useMutation({
    mutationFn: async ({ id, data }: { id?: number; data: Record<string, unknown> }) => {
      const token = await getToken();
      const url = id ? `/api/catalog/${id}` : "/api/catalog";
      const method = id ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => { setEditItem(null); qc.invalidateQueries({ queryKey: ["edit-catalog"] }); },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const token = await getToken();
      const r = await fetch(`/api/catalog/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => { setDeleteId(null); qc.invalidateQueries({ queryKey: ["edit-catalog"] }); },
  });

  const filtered = items.filter(item => {
    if (!showWoo && item.isWooManaged) return false;
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      item.name.toLowerCase().includes(s) ||
      (item.alavontName ?? "").toLowerCase().includes(s) ||
      (item.luciferCruzName ?? "").toLowerCase().includes(s) ||
      (item.category ?? "").toLowerCase().includes(s)
    );
  });

  const alavontCount = items.filter(i => !i.isWooManaged).length;
  const wooCount = items.filter(i => i.isWooManaged).length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Edit Catalog</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {alavontCount} Alavont products · {wooCount} WooCommerce (read-only)
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            className="gap-1.5"
          >
            <RefreshCw size={13} />
            Refresh
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => setEditItem({ ...EMPTY_FORM })}
          >
            <Plus size={13} />
            Add Product
          </Button>
        </div>
      </div>

      {/* Search + filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, category…"
            className="pl-8 text-sm"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X size={12} />
            </button>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
          <input type="checkbox" checked={showWoo} onChange={e => setShowWoo(e.target.checked)} className="w-3.5 h-3.5" />
          Show WooCommerce products
        </label>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Products", value: alavontCount, icon: Package, color: "text-blue-400" },
          { label: "Available", value: items.filter(i => !i.isWooManaged && i.isAvailable).length, icon: CheckCircle, color: "text-green-400" },
          { label: "Hidden / Unavailable", value: items.filter(i => !i.isWooManaged && !i.isAvailable).length, icon: XCircle, color: "text-red-400" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="glass-card rounded-xl p-3 flex items-center gap-3">
            <Icon size={17} className={color} />
            <div>
              <div className="text-lg font-bold leading-none">{value}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="glass-card rounded-2xl overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            Loading catalog…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
            <Package size={32} className="opacity-30" />
            <p className="text-sm">{search ? "No products match your search" : "No products in catalog"}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/30">
                  <th className="text-left p-3 text-xs text-muted-foreground font-semibold">Product</th>
                  <th className="text-left p-3 text-xs text-muted-foreground font-semibold">LC Name</th>
                  <th className="text-left p-3 text-xs text-muted-foreground font-semibold">Category</th>
                  <th className="text-right p-3 text-xs text-muted-foreground font-semibold">Price</th>
                  <th className="text-center p-3 text-xs text-muted-foreground font-semibold">Status</th>
                  <th className="text-center p-3 text-xs text-muted-foreground font-semibold">Source</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => (
                  <tr key={item.id} className="border-b border-border/10 hover:bg-white/[0.02] transition-colors">
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        {item.alavontImageUrl || item.imageUrl ? (
                          <img src={(item.alavontImageUrl || item.imageUrl)!} alt="" className="w-8 h-8 rounded-lg object-cover" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        ) : (
                          <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center">
                            <Image size={12} className="text-muted-foreground" />
                          </div>
                        )}
                        <div>
                          <div className="font-medium text-sm leading-tight">{item.alavontName || item.name}</div>
                          {item.labName && <div className="text-[10px] text-muted-foreground">{item.labName}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="p-3 text-muted-foreground text-sm">
                      {item.luciferCruzName ?? <span className="text-muted-foreground/40 italic text-xs">—</span>}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1">
                        <Tag size={10} className="text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">{item.alavontCategory ?? item.category}</span>
                      </div>
                    </td>
                    <td className="p-3 text-right font-mono text-sm">
                      ${item.price.toFixed(2)}
                      {item.regularPrice && item.regularPrice > item.price && (
                        <div className="text-[10px] text-muted-foreground line-through">${item.regularPrice.toFixed(2)}</div>
                      )}
                    </td>
                    <td className="p-3 text-center">
                      {item.isAvailable
                        ? <span className="text-[10px] font-semibold text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full">Active</span>
                        : <span className="text-[10px] font-semibold text-red-400 bg-red-400/10 px-2 py-0.5 rounded-full">Hidden</span>
                      }
                    </td>
                    <td className="p-3 text-center">
                      {item.isWooManaged
                        ? <span className="text-[10px] font-semibold text-orange-400 bg-orange-400/10 px-2 py-0.5 rounded-full flex items-center gap-1 justify-center"><Link2 size={8} />WooCommerce</span>
                        : <span className="text-[10px] font-semibold text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded-full flex items-center gap-1 justify-center"><FlaskConical size={8} />Local</span>
                      }
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => setEditItem(item)}
                          className="p-1.5 rounded-lg hover:bg-white/5 text-muted-foreground hover:text-foreground transition-colors"
                          title="Edit"
                        >
                          <Edit2 size={13} />
                        </button>
                        {!item.isWooManaged && (
                          <button
                            onClick={() => setDeleteId(item.id)}
                            className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit dialog */}
      {editItem !== null && (
        <EditDialog
          item={editItem}
          onClose={() => setEditItem(null)}
          onSave={data => saveMutation.mutate({ id: editItem.id, data })}
          isSaving={saveMutation.isPending}
        />
      )}

      {/* Delete confirm dialog */}
      {deleteId !== null && (
        <Dialog open onOpenChange={() => setDeleteId(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-red-400">
                <Trash2 size={16} />
                Delete Product
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground py-2">
              This will permanently remove the product and its inventory records. This cannot be undone.
            </p>
            <div className="flex gap-2 pt-1">
              <Button
                variant="destructive"
                className="flex-1"
                onClick={() => deleteMutation.mutate(deleteId)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? <Loader2 size={13} className="animate-spin mr-2" /> : null}
                Delete
              </Button>
              <Button variant="outline" onClick={() => setDeleteId(null)} disabled={deleteMutation.isPending}>
                Cancel
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
