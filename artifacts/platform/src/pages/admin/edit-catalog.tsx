import { useState, useCallback, useEffect, useRef } from "react";
import AdminInventory from "@/pages/admin/inventory";
import AdminCatalogueProducts from "@/pages/admin/catalogue-products";
import { useSearch } from "wouter";
import { useAuth } from "@clerk/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Edit2, Trash2, Search, RefreshCw, Loader2, FlaskConical, Link2,
  Tag, Image, CheckCircle, XCircle, Package, X, Save, ArchiveRestore,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { catalogProductDraftIsValid, createCatalogProductPayload, sanitizedCatalogError, validateCatalogProductDraft } from "@/lib/catalogProductForm";
import { CATALOG_LIFECYCLE_LABEL, type CatalogLifecycleStatus } from "@/lib/catalogLifecycleStatus";
import { useGetCurrentUser } from "@workspace/api-client-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

type CatalogProduct = {
  id: number;
  name: string;
  alavontName: string | null;
  luciferCruzName: string | null;
  luciferCruzCategory: string | null;
  luciferCruzDescription: string | null;
  luciferCruzImageUrl: string | null;
  merchantCategory?: string | null;
  merchantImage?: string | null;
  merchantSku?: string | null;
  customerSafeName: string | null;
  customerSafeDescription: string | null;
  alavontCategory: string | null;
  category: string;
  description: string | null;
  alavontDescription: string | null;
  price: number;
  regularPrice: number | null;
  compareAtPrice: number | null;
  homiePrice: number | null;
  imageUrl: string | null;
  alavontImageUrl: string | null;
  isAvailable: boolean;
  isTaxable: boolean;
  isWooManaged: boolean;
  isLocalAlavont: boolean;
  sku: string | null;
  alavontInStock: boolean | null;
  showCatalogueStockIndicator: boolean;
  displayName: string | null;
  displayCategory: string | null;
  displayDescription: string | null;
  displayImage: string | null;
  marketingCopy: string | null;
  upsellCopy: string | null;
  promoBadges: string[] | null;
  mediaGallery: unknown[] | null;
  labName: string | null;
  receiptName: string | null;
  isFeatured: boolean;
  isSaleFeatured: boolean;
  parLevel: number | string | null;
  moq: number | string | null;
  preferredReorderQuantity: number | string | null;
  stockQuantity: number | null;
  lifecycleStatus?: CatalogLifecycleStatus;
  metadata?: { complianceReason?: string | null; complianceHold?: boolean; activeSale?: boolean } | null;
  activeSale?: boolean;
};

const EMPTY_FORM: Partial<CatalogProduct> & { price: number; isAvailable: boolean; isTaxable: boolean; isWooManaged: boolean } = {
  name: "",
  alavontName: "",
  luciferCruzName: "",
  category: "",
  alavontCategory: "",
  description: "",
  alavontDescription: "",
  price: 0,
  regularPrice: null,
  compareAtPrice: null,
  homiePrice: null,
  imageUrl: "",
  alavontImageUrl: "",
  luciferCruzImageUrl: "",
  luciferCruzDescription: "",
  luciferCruzCategory: "",
  customerSafeName: "",
  customerSafeDescription: "",
  labName: "",
  isAvailable: true,
  isTaxable: true,
  isWooManaged: false,
  isFeatured: false,
  isSaleFeatured: false,
  parLevel: 0,
  moq: 0,
  preferredReorderQuantity: 0,
};

function fieldVal(v: unknown): string {
  return v == null ? "" : String(v);
}

// ─── Edit Dialog ───────────────────────────────────────────────────────────────

function ProductEditor({
  item,
  onClose,
  onSave,
  isSaving,
  canManageCompliance,
  onManageCompliance,
}: {
  item: Partial<CatalogProduct> | null;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  isSaving: boolean;
  canManageCompliance: boolean;
  onManageCompliance: () => void;
}) {
  const isNew = !item?.id;
  const isWoo = item?.isWooManaged === true;

  const [form, setForm] = useState<Record<string, string | boolean | number>>({
    name: fieldVal(item?.name),
    alavontName: fieldVal(item?.alavontName ?? item?.name),
    category: fieldVal(item?.category),
    alavontCategory: fieldVal(item?.alavontCategory ?? item?.category),
    price: fieldVal(item?.price),
    regularPrice: fieldVal(item?.regularPrice),
    compareAtPrice: fieldVal(item?.compareAtPrice),
    homiePrice: fieldVal(item?.homiePrice),
    alavontImageUrl: fieldVal(item?.alavontImageUrl),
    alavontDescription: fieldVal(item?.alavontDescription),
    merchantCategory: fieldVal(item?.merchantCategory),
    merchantImage: fieldVal(item?.merchantImage),
    merchantSku: fieldVal(item?.merchantSku),
    showCatalogueStockIndicator: item?.showCatalogueStockIndicator !== false,
    customerSafeName: fieldVal(item?.customerSafeName),
    customerSafeDescription: fieldVal(item?.customerSafeDescription),
    isAvailable: item?.isAvailable !== false,
    isTaxable: item?.isTaxable !== false,
    isFeatured: item?.isFeatured === true,
    isSaleFeatured: item?.isSaleFeatured === true,
    activeSale: item?.activeSale === true || item?.metadata?.activeSale === true,
    parLevel: fieldVal(item?.parLevel),
    moq: fieldVal(item?.moq),
    preferredReorderQuantity: fieldVal(item?.preferredReorderQuantity),
  });
  const [fieldErrors, setFieldErrors] = useState(validateCatalogProductDraft(form));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const submitLock = useRef(false);
  const requestPending = isSaving || submitting;

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setForm(f => ({ ...f, [k]: value }));
    const errorKey = k === "alavontName" ? "name" : k === "alavontCategory" ? "category" : k;
    setFieldErrors(errors => ({ ...errors, [errorKey]: undefined }));
    setSubmitError(null);
    setSaved(false);
  };

  async function handleSave() {
    if (submitLock.current) return;
    const errors = validateCatalogProductDraft(form);
    setFieldErrors(errors);
    setSubmitError(null);
    if (Object.keys(errors).length > 0) return;
    submitLock.current = true;
    setSubmitting(true);
    const payload = Object.fromEntries(Object.entries(createCatalogProductPayload(form))
      .filter(([key]) => key in form && (isNew || (key !== "name" && key !== "category"))));
    try {
      await onSave(payload);
      setSaved(true);
    } catch (error) {
      setSubmitError(sanitizedCatalogError(error));
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  const input = (label: string, key: string, disabled = false, type = "text", help?: string) => {
    const error = key === "alavontName" ? fieldErrors.name : key === "alavontCategory" ? fieldErrors.category : fieldErrors[key as keyof typeof fieldErrors];
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={`catalog-editor-${key}`} className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground font-medium">{label}{["alavontName", "alavontCategory", "price"].includes(key) ? " *" : ""}</span>
          <Input
            id={`catalog-editor-${key}`}
            type={type}
            value={fieldVal(form[key])}
            onChange={set(key)}
            disabled={disabled || requestPending}
            aria-describedby={help ? `catalog-editor-help-${key}` : undefined}
            className="text-sm"
            placeholder={disabled ? "WooCommerce managed" : undefined}
          />
        </label>
        {help && <p id={`catalog-editor-help-${key}`} className="text-xs leading-relaxed text-muted-foreground">{help}</p>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    );
  };

  return (
    <section className="scroll-mt-4 space-y-5 rounded-xl border border-border bg-card p-4 sm:p-6" aria-label="Product details">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold">{isNew ? "Add product" : item?.alavontName ?? item?.name}</h2>
          {isWoo && <Badge variant="outline">WooCommerce</Badge>}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={requestPending} aria-label="Close product editor"><X size={16} /></Button>
      </header>
          {!isNew && canManageCompliance && <section className="rounded-lg border border-orange-400/30 bg-orange-400/5 p-4 space-y-2" aria-label="Compliance">
            <h3 className="font-semibold">Compliance</h3>
            <p className="text-sm font-semibold">{item?.lifecycleStatus === "compliance_hold" ? "COMPLIANCE HOLD" : "No active compliance hold"}</p>
            {item?.lifecycleStatus === "compliance_hold" && <p className="text-sm text-muted-foreground">{item.metadata?.complianceReason || "Reason not recorded"}</p>}
            <p className="text-xs text-muted-foreground">Only Global Admin can change this audited server-side hold. Inventory is preserved.</p>
            <Button type="button" variant={item?.lifecycleStatus === "compliance_hold" ? "destructive" : "outline"} onClick={onManageCompliance} disabled={requestPending}>
              {item?.lifecycleStatus === "compliance_hold" ? "Release compliance hold" : "Place compliance hold"}
            </Button>
          </section>}
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="space-y-3 rounded-lg border border-border/60 p-4">
          <h3 className="font-semibold">Alavont / Vendor</h3>
          {input("Vendor Name", "alavontName", isWoo)}
          {input("Alavont Image URL", "alavontImageUrl", isWoo)}
          {input("Alavont Category", "alavontCategory", isWoo)}
          <label className="block text-sm font-medium">Alavont Description
            <textarea value={fieldVal(form.alavontDescription)} onChange={set("alavontDescription")}
              disabled={isWoo || requestPending} rows={3}
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </label>
        </section>
        <section className="space-y-3 rounded-lg border border-border/60 p-4">
          <h3 className="font-semibold">Safe checkout</h3>
          {input("Safe Name", "customerSafeName")}
          {input("Safe Image URL", "merchantImage")}
          {input("Safe Category", "merchantCategory")}
          {input("Safe SKU", "merchantSku")}
          <label className="block text-sm font-medium">Safe Description
            <textarea value={fieldVal(form.customerSafeDescription)} onChange={set("customerSafeDescription")}
              disabled={requestPending} rows={3}
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </label>
        </section>
      </div>
      <section className="space-y-3 rounded-lg border border-border/60 p-4">
        <h3 className="font-semibold">Pricing and stock</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {input("Safe Price ($)", "price", isWoo, "number")}
          {input("Safe Sale Price ($)", "compareAtPrice", false, "number")}
          {input("Safe Regular / Compare-at Price ($)", "regularPrice", false, "number")}
          {input("Safe Employee Discount ($)", "homiePrice", false, "number")}
          {input("Safe PAR", "parLevel", false, "number")}
          <div>
            <p className="text-xs font-medium text-muted-foreground">Safe stock</p>
            <p className="text-sm">{isNew ? "Count stock after creating the product." : "See current quantities under Inventory by location."}</p>
          </div>
        </div>
        <details>
          <summary className="cursor-pointer text-sm font-medium">Reorder settings</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {input("Minimum Order Quantity", "moq", false, "number")}
            {input("Preferred Reorder Quantity", "preferredReorderQuantity", false, "number")}
          </div>
        </details>
      </section>

          {/* Availability */}
          {!isWoo && (
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Availability</div>
              <p className="mb-2 text-xs text-muted-foreground">Sale Price is charged only when “Sale (charge sale price)” is enabled. The sale marker is visual only.</p>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(form.isAvailable)}
                  onChange={e => setForm(f => ({ ...f, isAvailable: e.target.checked }))}
                  disabled={requestPending}
                  className="w-4 h-4"
                />
                <span className="text-sm">Available for ordering</span>
              </label>
              <label className="mt-3 flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={Boolean(form.isTaxable)} onChange={e => setForm(f => ({ ...f, isTaxable: e.target.checked }))} disabled={requestPending} className="w-4 h-4" />
                <span className="text-sm">Taxable at the transaction location</span>
              </label>
              <label className="mt-3 flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={Boolean(form.showCatalogueStockIndicator)} onChange={e => setForm(f => ({ ...f, showCatalogueStockIndicator: e.target.checked }))} disabled={requestPending} className="w-4 h-4" />
                <span className="text-sm">Show stock count</span>
              </label>
              <label className="mt-3 flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={Boolean(form.isFeatured)} onChange={e => setForm(f => ({ ...f, isFeatured: e.target.checked }))} disabled={requestPending} className="w-4 h-4" />
                <span className="text-sm">Featured (promote in catalogue)</span>
              </label>
              <label className="mt-3 flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={Boolean(form.isSaleFeatured)} onChange={e => setForm(f => ({ ...f, isSaleFeatured: e.target.checked }))} disabled={requestPending} className="w-4 h-4" />
                <span className="text-sm">Sale marker</span>
              </label>
              <label className="mt-3 flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={Boolean(form.activeSale)} onChange={e => setForm(f => ({ ...f, activeSale: e.target.checked }))} disabled={requestPending} className="w-4 h-4" />
                <span className="text-sm">Sale (charge sale price)</span>
              </label>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button type="button" onClick={() => void handleSave()} disabled={requestPending || !catalogProductDraftIsValid(form)} className="flex-1">
              {requestPending ? <Loader2 size={14} className="animate-spin mr-2" /> : <Save size={14} className="mr-2" />}
              {requestPending ? (isNew ? "Creating…" : "Saving…") : (isNew ? "Create Product" : "Save Changes")}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} disabled={requestPending}>
              Cancel
            </Button>
          </div>
          {saved && <p role="status" className="text-sm text-emerald-600">Product details saved.</p>}
          {submitError && <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{submitError}</div>}
    </section>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminEditCatalog() {
  const { getToken } = useAuth();
  const { data: currentUser } = useGetCurrentUser();
  const isGlobalAdmin = currentUser?.role === "global_admin";
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showWoo, setShowWoo] = useState(false);
  const [lifecycleFilter, setLifecycleFilter] = useState<"all" | CatalogLifecycleStatus>("all");
  const [editItem, setEditItem] = useState<Partial<CatalogProduct> | null>(null);
  const [showInventory, setShowInventory] = useState(false);
  const [editorRefresh, setEditorRefresh] = useState(0);
  const searchParams = useSearch();
  const requestedItemId = new URLSearchParams(searchParams).get("catalogItemId");
  const editorAnchor = useRef<HTMLDivElement>(null);
  const openedLink = useRef<string | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [saveConfirmation, setSaveConfirmation] = useState<string | null>(null);
  const [complianceItem, setComplianceItem] = useState<CatalogProduct | null>(null);
  const [complianceReason, setComplianceReason] = useState("");
  const [complianceError, setComplianceError] = useState<string | null>(null);

  const [restoreItem, setRestoreItem] = useState<CatalogProduct | null>(null);
  const [restoreReason, setRestoreReason] = useState("");

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

  useEffect(() => {
    if (!requestedItemId || openedLink.current === requestedItemId) return;
    const item = items.find(entry => String(entry.id) === requestedItemId);
    if (item) {
      openedLink.current = requestedItemId;
      setEditItem(item);
    }
  }, [items, requestedItemId]);
  const editorOpen = editItem !== null;
  const editorItemId = editItem?.id;
  useEffect(() => {
    if (editorOpen) editorAnchor.current?.scrollIntoView({ block: "start" });
  }, [editorItemId, editorOpen]);

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
      return r.json() as Promise<CatalogProduct>;
    },
    onSuccess: async (saved, { id }) => {
      qc.setQueryData<CatalogProduct[]>(["edit-catalog"], current => {
        const withoutSaved = (current ?? []).filter(item => item.id !== saved.id);
        return [...withoutSaved, saved];
      });
      setSaveConfirmation(`Product ${saved.id} saved.`);
      setEditItem(current => current && current.id === id ? { ...current, ...saved } : current);
      setEditorRefresh(current => current + 1);
      await qc.invalidateQueries({ queryKey: ["edit-catalog"], refetchType: "active" });
    },
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
    onSuccess: async () => { setDeleteId(null); await qc.invalidateQueries({ queryKey: ["edit-catalog"] }); await refetch(); },
  });

  const complianceMutation = useMutation({
    mutationFn: async ({ item, reason }: { item: CatalogProduct; reason: string }) => {
      const token = await getToken();
      const response = await fetch(`/api/admin/product-master/${item.id}/lifecycle`, { method: "PATCH", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ complianceHold: item.lifecycleStatus !== "compliance_hold", reason }) });
      if (!response.ok) throw new Error(`Compliance action rejected (HTTP ${response.status})`);
      return response.json();
    },
    onSuccess: async () => { setComplianceItem(null); setComplianceReason(""); setComplianceError(null); await qc.invalidateQueries({ queryKey: ["edit-catalog"] }); await refetch(); },
    onError: error => setComplianceError(error instanceof Error ? error.message : "Compliance action failed"),
  });

  const restoreMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const token = await getToken();
      const response = await fetch(`/api/admin/product-master/${id}/lifecycle`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false, reason }),
      });
      if (!response.ok) throw new Error(`Unarchive failed (HTTP ${response.status}).`);
    },
    onSuccess: async (_data, { id }) => {
      setRestoreItem(null);
      setSaveConfirmation(`Product ${id} unarchived.`);
      await qc.invalidateQueries({ queryKey: ["edit-catalog"] });
    },
  });

  const filtered = items.filter(item => {
    if (!showWoo && item.isWooManaged) return false;
    if (!item.isWooManaged && lifecycleFilter !== "all" && item.lifecycleStatus !== lifecycleFilter) return false;
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      item.name.toLowerCase().includes(s) ||
      (item.alavontName ?? "").toLowerCase().includes(s) ||
      (item.customerSafeName ?? "").toLowerCase().includes(s) ||
      (item.luciferCruzName ?? "").toLowerCase().includes(s) ||
      (item.category ?? "").toLowerCase().includes(s)
    );
  });

  const alavontCount = items.filter(i => !i.isWooManaged).length;
  const wooCount = items.filter(i => i.isWooManaged).length;
  const localItems = items.filter(i => !i.isWooManaged);
  const lifecycleCounts = {
    customerVisible: localItems.filter(item => item.lifecycleStatus === "customer_visible").length,
    unavailableHidden: localItems.filter(item => item.lifecycleStatus === "unavailable_hidden").length,
    complianceHold: localItems.filter(item => item.lifecycleStatus === "compliance_hold").length,
    archived: localItems.filter(item => item.lifecycleStatus === "archived").length,
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Catalog & Inventory</h1>
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

      {editItem !== null && (
        <div ref={editorAnchor} className="scroll-mt-4 space-y-4">
          <ProductEditor
            key={editItem.id ?? "new"}
            item={editItem}
            onClose={() => setEditItem(null)}
            onSave={async data => { await saveMutation.mutateAsync({ id: editItem.id, data }); }}
            isSaving={saveMutation.isPending}
            canManageCompliance={isGlobalAdmin}
            onManageCompliance={() => { setComplianceItem(editItem as CatalogProduct); setComplianceReason(""); setComplianceError(null); }}
          />
          {editItem.id && !editItem.isWooManaged && <AdminCatalogueProducts key={editItem.id} catalogItemId={editItem.id} refreshKey={editorRefresh} />}
        </div>
      )}

      {/* Search + filters */}
      {saveConfirmation && (
        <div role="status" className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-300">
          {saveConfirmation}
        </div>
      )}
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
        <select aria-label="Catalogue lifecycle filter" value={lifecycleFilter} onChange={event => setLifecycleFilter(event.target.value as "all" | CatalogLifecycleStatus)} className="h-9 rounded-md border bg-background px-2 text-sm">
          <option value="all">All</option>
          <option value="customer_visible">Customer Visible</option>
          <option value="compliance_hold">Held</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { label: "Total Products", value: alavontCount, icon: Package, color: "text-blue-400" },
          { label: "Customer Visible", value: lifecycleCounts.customerVisible, icon: CheckCircle, color: "text-green-400" },
          { label: "Unavailable / Hidden", value: lifecycleCounts.unavailableHidden, icon: XCircle, color: "text-amber-400" },
          { label: "Compliance Hold", value: lifecycleCounts.complianceHold, icon: XCircle, color: "text-orange-400" },
          { label: "Archived", value: lifecycleCounts.archived, icon: XCircle, color: "text-red-400" },
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
                  <th className="text-left p-3 text-xs text-muted-foreground font-semibold">Vendor Name</th>
                  <th className="text-left p-3 text-xs text-muted-foreground font-semibold">Safe Name</th>
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

                        </div>
                      </div>
                    </td>
                    <td className="p-3 text-muted-foreground text-sm">
                      {item.customerSafeName ?? item.luciferCruzName ?? <span className="text-muted-foreground/40 italic text-xs">—</span>}
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
                      {(() => {
                        const lifecycle = item.lifecycleStatus ?? "unavailable_hidden";
                        const style = lifecycle === "customer_visible" ? "text-green-400 bg-green-400/10" : lifecycle === "archived" ? "text-red-400 bg-red-400/10" : lifecycle === "compliance_hold" ? "text-orange-400 bg-orange-400/10" : "text-amber-400 bg-amber-400/10";
                        return <span className={`text-[10px] font-semibold ${style} px-2 py-0.5 rounded-full`}>{CATALOG_LIFECYCLE_LABEL[lifecycle]}</span>;
                      })()}
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
                        {isGlobalAdmin && !item.isWooManaged && item.lifecycleStatus === "archived" && (
                          <button type="button" title="Unarchive" aria-label={`Unarchive ${item.name}`}
                            className="rounded-lg p-1.5 text-primary hover:bg-primary/10"
                            onClick={() => { restoreMutation.reset(); setRestoreReason(""); setRestoreItem(item); }}>
                            <ArchiveRestore size={13} />
                          </button>
                        )}
                        {isGlobalAdmin && <button onClick={() => { setComplianceItem(item); setComplianceReason(""); setComplianceError(null); }} className="p-1.5 rounded-lg hover:bg-orange-500/10 text-orange-300" title={item.lifecycleStatus === "compliance_hold" ? "Review compliance hold" : "Place compliance hold"} aria-label={`${item.lifecycleStatus === "compliance_hold" ? "Review" : "Place"} compliance hold for ${item.name}`}><XCircle size={13} /></button>}
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

      <details className="rounded-xl border border-border p-3" onToggle={event => setShowInventory(event.currentTarget.open)}>
        <summary className="cursor-pointer px-1 py-2 font-semibold">Inventory across all products and locations</summary>
        {showInventory && <AdminInventory />}
      </details>

      {complianceItem && <Dialog open onOpenChange={() => setComplianceItem(null)}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>{complianceItem.lifecycleStatus === "compliance_hold" ? "Review compliance hold" : "Place compliance hold"}</DialogTitle></DialogHeader><p className="text-sm">{complianceItem.name}</p><p className="text-xs text-muted-foreground">Current hold: {complianceItem.lifecycleStatus === "compliance_hold" ? "Active" : "None"}. Reason: {complianceItem.metadata?.complianceReason || "—"}</p><label className="text-xs">Audit reason<Input value={complianceReason} onChange={event => setComplianceReason(event.target.value)} maxLength={500} aria-label="Compliance action reason" /></label>{complianceError && <p role="alert" className="text-xs text-red-400">{complianceError}</p>}<Button disabled={!complianceReason.trim() || complianceMutation.isPending} onClick={() => complianceMutation.mutate({ item: complianceItem, reason: complianceReason.trim() })}>{complianceItem.lifecycleStatus === "compliance_hold" ? "Remove hold as Global Admin" : "Place hold"}</Button></DialogContent></Dialog>}

      {restoreItem && (
        <Dialog open onOpenChange={open => { if (!open && !restoreMutation.isPending) setRestoreItem(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Unarchive product</DialogTitle></DialogHeader>
            <p className="text-sm">{restoreItem.name}</p>
            <p className="text-sm text-muted-foreground">An available product can reappear in the customer catalog after it is unarchived.</p>
            <label className="text-sm">
              Audit reason
              <Input value={restoreReason} onChange={event => setRestoreReason(event.target.value)} maxLength={500} />
            </label>
            {restoreMutation.error && <p role="alert" className="text-sm text-destructive">{restoreMutation.error.message}</p>}
            <Button disabled={!restoreReason.trim() || restoreMutation.isPending}
              onClick={() => restoreMutation.mutate({ id: restoreItem.id, reason: restoreReason.trim() })}>
              {restoreMutation.isPending ? "Unarchiving…" : "Unarchive product"}
            </Button>
          </DialogContent>
        </Dialog>
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
              This archives products with order/inventory history and only hard-deletes products with no history. The item disappears from catalog, inventory, checkout, CSR shift inventory, and Zappy after confirmation.
            </p>
            <div className="flex gap-2 pt-1">
              <Button
                variant="destructive"
                className="flex-1"
                onClick={() => deleteMutation.mutate(deleteId)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? <Loader2 size={13} className="animate-spin mr-2" /> : null}
                Archive / Delete
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
