import { useState, useCallback } from "react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeNotificationRole } from "@/hooks/usePushNotifications";
import {
  Package, Plus, Edit2, Trash2, ToggleLeft, ToggleRight,
  Tag, DollarSign, XCircle, RefreshCw, Check, X, ChevronDown, ChevronUp, BadgePercent
} from "lucide-react";

type Bundle = {
  id: number;
  name: string;
  description: string | null;
  price: number;
  isActive: boolean;
  memberItemIds: number[];
};

type CatalogItem = {
  id: number;
  name: string;
  price: number;
  category: string;
  isAvailable: boolean;
  compareAtPrice: number | null;
};

function formatPrice(p: number) {
  return `$${p.toFixed(2)}`;
}

export default function SalesPackages() {
  const { data: userRes } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const user = userRes;
  const { getToken } = useAuth();
  const qc = useQueryClient();

  const [showBundleForm, setShowBundleForm] = useState(false);
  const [editingBundle, setEditingBundle] = useState<Bundle | null>(null);
  const [salePriceItemId, setSalePriceItemId] = useState<number | null>(null);
  const [salePriceInput, setSalePriceInput] = useState("");
  const [expandedBundleId, setExpandedBundleId] = useState<number | null>(null);

  const [form, setForm] = useState({
    name: "",
    description: "",
    price: "",
    memberItemIds: [] as number[],
  });

  const authFetch = useCallback(async (path: string, init?: RequestInit) => {
    const token = await getToken();
    return fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  }, [getToken]);

  const { data: bundlesData, isLoading: bundlesLoading, refetch: refetchBundles } = useQuery<{ bundles: Bundle[] }>({
    queryKey: ["admin-bundles"],
    queryFn: async () => {
      const r = await authFetch("/api/admin/bundles");
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const { data: catalogData, isLoading: catalogLoading } = useQuery<{ items: CatalogItem[] }>({
    queryKey: ["admin-bundles-catalog"],
    queryFn: async () => {
      const r = await authFetch("/api/admin/bundles/catalog-items");
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  });

  const createBundle = useMutation({
    mutationFn: async (data: typeof form) => {
      const r = await authFetch("/api/admin/bundles", {
        method: "POST",
        body: JSON.stringify({
          name: data.name,
          description: data.description || null,
          price: parseFloat(data.price),
          memberItemIds: data.memberItemIds,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-bundles"] });
      resetForm();
    },
  });

  const updateBundle = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Partial<Bundle> }) => {
      const r = await authFetch(`/api/admin/bundles/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-bundles"] });
      setEditingBundle(null);
      resetForm();
      setShowBundleForm(false);
    },
  });

  const deleteBundle = useMutation({
    mutationFn: async (id: number) => {
      const r = await authFetch(`/api/admin/bundles/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-bundles"] }),
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      const r = await authFetch(`/api/admin/bundles/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-bundles"] }),
  });

  const setSalePrice = useMutation({
    mutationFn: async ({ itemId, salePrice }: { itemId: number; salePrice: number }) => {
      const r = await authFetch(`/api/admin/bundles/set-sale-price/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ salePrice }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-bundles-catalog"] });
      setSalePriceItemId(null);
      setSalePriceInput("");
    },
  });

  const clearSalePrice = useMutation({
    mutationFn: async (itemId: number) => {
      const r = await authFetch(`/api/admin/bundles/set-sale-price/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ clearSale: true }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-bundles-catalog"] }),
  });

  function resetForm() {
    setForm({ name: "", description: "", price: "", memberItemIds: [] });
    setEditingBundle(null);
  }

  function openCreateForm() {
    resetForm();
    setShowBundleForm(true);
  }

  function openEditForm(bundle: Bundle) {
    setEditingBundle(bundle);
    setForm({
      name: bundle.name,
      description: bundle.description ?? "",
      price: String(bundle.price),
      memberItemIds: bundle.memberItemIds,
    });
    setShowBundleForm(true);
  }

  function toggleMemberItem(id: number) {
    setForm(f => ({
      ...f,
      memberItemIds: f.memberItemIds.includes(id)
        ? f.memberItemIds.filter(x => x !== id)
        : [...f.memberItemIds, id],
    }));
  }

  function submitForm() {
    if (!form.name.trim()) return;
    const price = parseFloat(form.price);
    if (isNaN(price) || price < 0) return;
    if (editingBundle) {
      updateBundle.mutate({
        id: editingBundle.id,
        patch: {
          name: form.name,
          description: form.description || null,
          price,
          memberItemIds: form.memberItemIds,
        },
      });
    } else {
      createBundle.mutate(form);
    }
  }

  const userRole = normalizeNotificationRole(user?.role);
  if (!user || (userRole !== "global_admin" && userRole !== "admin")) {
    return (
      <div className="glass-card rounded-2xl p-8 text-center">
        <XCircle className="mx-auto text-red-400 mb-3" size={32} />
        <div className="text-sm font-semibold">Admin access required</div>
      </div>
    );
  }

  const bundles = bundlesData?.bundles ?? [];
  const catalogItems = catalogData?.items ?? [];
  const isPending = createBundle.isPending || updateBundle.isPending;

  const categories = Array.from(new Set(catalogItems.map(i => i.category))).sort();

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Package size={22} className="text-primary" />
            Sales & Packages
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Create product bundles and manage sale prices across the catalog
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="rounded-xl text-xs h-9 gap-1.5"
            onClick={() => refetchBundles()}
            disabled={bundlesLoading}
          >
            <RefreshCw size={12} className={bundlesLoading ? "animate-spin" : ""} />
            Refresh
          </Button>
          <Button
            size="sm"
            className="rounded-xl text-xs h-9 gap-1.5"
            onClick={openCreateForm}
          >
            <Plus size={13} />
            New Bundle
          </Button>
        </div>
      </div>

      {/* Bundle Create/Edit Form */}
      {showBundleForm && (
        <div className="glass-card rounded-2xl p-6 border border-primary/20 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold flex items-center gap-2">
              <Package size={16} className="text-primary" />
              {editingBundle ? "Edit Bundle" : "Create Bundle"}
            </h2>
            <button
              onClick={() => { setShowBundleForm(false); resetForm(); }}
              className="text-muted-foreground hover:text-foreground"
            >
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Bundle Name *</label>
              <Input
                placeholder="e.g. Weekend Starter Pack"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="rounded-xl h-9 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Bundle Price *</label>
              <div className="relative">
                <DollarSign size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="0.00"
                  value={form.price}
                  onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
                  className="rounded-xl h-9 text-sm pl-8"
                  type="number"
                  min="0"
                  step="0.01"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Promotional Description</label>
            <textarea
              placeholder="Describe this bundle to customers..."
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              className="w-full rounded-xl text-sm p-3 bg-background/50 border border-border/50 resize-none focus:outline-none focus:ring-1 focus:ring-primary/50 min-h-[80px]"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Include Items ({form.memberItemIds.length} selected)
            </label>
            {catalogLoading ? (
              <div className="text-xs text-muted-foreground py-4 text-center">
                <RefreshCw size={14} className="animate-spin inline mr-2" />Loading catalog...
              </div>
            ) : (
              <div className="space-y-3">
                {categories.map(cat => {
                  const items = catalogItems.filter(i => i.category === cat);
                  return (
                    <div key={cat}>
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 px-1 mb-1">{cat}</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                        {items.map(item => {
                          const selected = form.memberItemIds.includes(item.id);
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => toggleMemberItem(item.id)}
                              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-left text-xs transition-all border ${
                                selected
                                  ? "bg-primary/15 border-primary/40 text-foreground"
                                  : "border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
                              }`}
                            >
                              <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 border ${
                                selected ? "bg-primary border-primary" : "border-border/50"
                              }`}>
                                {selected && <Check size={10} className="text-primary-foreground" />}
                              </div>
                              <span className="truncate flex-1">{item.name}</span>
                              <span className="font-mono text-emerald-400 shrink-0">{formatPrice(item.price)}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                {catalogItems.length === 0 && (
                  <div className="text-xs text-muted-foreground text-center py-4">No catalog items found</div>
                )}
              </div>
            )}
          </div>

          {(createBundle.error || updateBundle.error) && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">
              {String(createBundle.error ?? updateBundle.error)}
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl text-xs h-9"
              onClick={() => { setShowBundleForm(false); resetForm(); }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="rounded-xl text-xs h-9 gap-1.5"
              onClick={submitForm}
              disabled={isPending || !form.name.trim() || !form.price}
            >
              {isPending ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
              {editingBundle ? "Save Changes" : "Create Bundle"}
            </Button>
          </div>
        </div>
      )}

      {/* Existing Bundles */}
      <div className="space-y-3">
        <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground px-1">
          Bundles ({bundles.length})
        </div>

        {bundlesLoading ? (
          <div className="glass-card rounded-xl p-8 text-center text-sm text-muted-foreground">
            <RefreshCw size={20} className="animate-spin mx-auto mb-3" />
            Loading bundles...
          </div>
        ) : bundles.length === 0 ? (
          <div className="glass-card rounded-xl p-8 text-center">
            <Package size={28} className="mx-auto text-muted-foreground/40 mb-3" />
            <div className="text-sm font-medium text-muted-foreground">No bundles yet</div>
            <div className="text-xs text-muted-foreground/60 mt-1">Create a bundle to get started</div>
            <Button size="sm" className="rounded-xl text-xs h-9 gap-1.5 mt-4" onClick={openCreateForm}>
              <Plus size={13} />
              Create First Bundle
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {bundles.map(bundle => {
              const memberItems = catalogItems.filter(i => bundle.memberItemIds.includes(i.id));
              const expanded = expandedBundleId === bundle.id;
              return (
                <div
                  key={bundle.id}
                  className={`glass-card rounded-xl border transition-all ${
                    bundle.isActive ? "border-border/30" : "border-border/10 opacity-60"
                  }`}
                >
                  <div className="p-4 flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm truncate">{bundle.name}</span>
                        <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 uppercase tracking-wider">
                          Bundle
                        </span>
                        {!bundle.isActive && (
                          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-muted/30 text-muted-foreground border border-border/30 uppercase tracking-wider">
                            Inactive
                          </span>
                        )}
                      </div>
                      {bundle.description && (
                        <div className="text-xs text-muted-foreground mt-0.5 truncate">{bundle.description}</div>
                      )}
                      <div className="flex items-center gap-3 mt-1">
                        <span className="font-mono text-emerald-400 text-sm font-bold">{formatPrice(bundle.price)}</span>
                        <span className="text-xs text-muted-foreground">
                          {bundle.memberItemIds.length} item{bundle.memberItemIds.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => setExpandedBundleId(expanded ? null : bundle.id)}
                        className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors"
                        title="View items"
                      >
                        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      <button
                        onClick={() => toggleActive.mutate({ id: bundle.id, isActive: !bundle.isActive })}
                        className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors"
                        title={bundle.isActive ? "Deactivate" : "Activate"}
                      >
                        {bundle.isActive ? (
                          <ToggleRight size={16} className="text-emerald-400" />
                        ) : (
                          <ToggleLeft size={16} />
                        )}
                      </button>
                      <button
                        onClick={() => openEditForm(bundle)}
                        className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors"
                        title="Edit"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Delete bundle "${bundle.name}"?`)) {
                            deleteBundle.mutate(bundle.id);
                          }
                        }}
                        className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="border-t border-border/20 px-4 py-3">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Included Items</div>
                      {memberItems.length === 0 ? (
                        <div className="text-xs text-muted-foreground italic">No items assigned</div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {memberItems.map(item => (
                            <div
                              key={item.id}
                              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-muted/20 border border-border/30 text-xs"
                            >
                              <Tag size={10} className="text-muted-foreground" />
                              <span>{item.name}</span>
                              <span className="font-mono text-emerald-400">{formatPrice(item.price)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Sale Prices Section */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Catalog Sale Prices
          </div>
          <div className="flex-1 h-px bg-border/30" />
        </div>
        <div className="text-xs text-muted-foreground">
          Set a promotional sale price on any catalog item. The original price will be shown as a strikethrough.
        </div>

        {catalogLoading ? (
          <div className="glass-card rounded-xl p-6 text-center text-sm text-muted-foreground">
            <RefreshCw size={16} className="animate-spin inline mr-2" />Loading...
          </div>
        ) : (
          <div className="glass-card rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/30 bg-muted/10">
                    <th className="text-left px-4 py-2.5 text-muted-foreground font-semibold uppercase tracking-wider">Item</th>
                    <th className="text-left px-4 py-2.5 text-muted-foreground font-semibold uppercase tracking-wider">Category</th>
                    <th className="text-left px-4 py-2.5 text-muted-foreground font-semibold uppercase tracking-wider">Current Price</th>
                    <th className="text-left px-4 py-2.5 text-muted-foreground font-semibold uppercase tracking-wider">Original</th>
                    <th className="text-left px-4 py-2.5 text-muted-foreground font-semibold uppercase tracking-wider">Sale Action</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogItems.map(item => {
                    const onSale = item.compareAtPrice !== null && item.compareAtPrice > item.price;
                    const isEditing = salePriceItemId === item.id;
                    return (
                      <tr key={item.id} className="border-b border-border/20 hover:bg-muted/5 transition-colors">
                        <td className="px-4 py-3 font-medium">{item.name}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          <span className="inline-flex px-2 py-0.5 rounded bg-muted/20 border border-border/30">
                            {item.category}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`font-mono font-bold ${onSale ? "text-orange-400" : "text-emerald-400"}`}>
                            {formatPrice(item.price)}
                          </span>
                          {onSale && (
                            <span className="ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 border border-orange-500/20 uppercase">
                              On Sale
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground font-mono">
                          {item.compareAtPrice ? (
                            <span className="line-through">{formatPrice(item.compareAtPrice)}</span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {isEditing ? (
                            <div className="flex items-center gap-2">
                              <div className="relative">
                                <DollarSign size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  placeholder="Sale price"
                                  value={salePriceInput}
                                  onChange={e => setSalePriceInput(e.target.value)}
                                  className="pl-6 h-7 w-28 rounded-lg text-xs"
                                  autoFocus
                                />
                              </div>
                              <button
                                onClick={() => {
                                  const p = parseFloat(salePriceInput);
                                  if (!isNaN(p) && p >= 0) setSalePrice.mutate({ itemId: item.id, salePrice: p });
                                }}
                                disabled={setSalePrice.isPending}
                                className="p-1.5 rounded-lg bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                              >
                                <Check size={12} />
                              </button>
                              <button
                                onClick={() => { setSalePriceItemId(null); setSalePriceInput(""); }}
                                className="p-1.5 rounded-lg hover:bg-muted/20 text-muted-foreground transition-colors"
                              >
                                <X size={12} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => {
                                  setSalePriceItemId(item.id);
                                  setSalePriceInput(String(item.price));
                                }}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider border border-border/40 text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors"
                              >
                                <BadgePercent size={11} />
                                Set Sale
                              </button>
                              {onSale && (
                                <button
                                  onClick={() => clearSalePrice.mutate(item.id)}
                                  disabled={clearSalePrice.isPending}
                                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                                >
                                  <X size={11} />
                                  Clear
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {catalogItems.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground text-sm">
                        No catalog items found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
