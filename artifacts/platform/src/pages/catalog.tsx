import { useState } from "react";
import {
  useListCatalogItems,
  useListCatalogCategories,
  useCreateCatalogItem,
  useUpdateCatalogItem,
  useGetCurrentUser,
  getListCatalogItemsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, Plus, Edit2, Package, ImageOff, ShoppingCart, FlaskConical, Flame } from "lucide-react";
import { Link } from "wouter";


type MenuMode = "alavont" | "lucifer";

function CatalogItemCard({
  item,
  canEdit,
  onEdit,
  menuMode,
}: {
  item: any;
  canEdit: boolean;
  onEdit: (item: any) => void;
  menuMode: MenuMode;
}) {
  const isLC = menuMode === "lucifer";

  return (
    <div
      className={`electric-catalog-card glass-card rounded-2xl overflow-hidden flex flex-col group cursor-pointer${isLC ? " lc-card" : ""}`}
      style={isLC ? { borderColor: "rgba(220,20,60,0.2)" } : { borderColor: "rgba(59,130,246,0.12)" }}
      data-testid={`card-product-${item.id}`}
    >
      {/* Thumbnail */}
      <div className="relative aspect-square overflow-hidden" style={{ background: isLC ? "#0A0000" : undefined }}>
        {(isLC ? item.luciferCruzImageUrl : item.imageUrl) ? (
          <img
            src={isLC ? item.luciferCruzImageUrl : item.imageUrl}
            alt={isLC ? (item.luciferCruzName || item.name) : item.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
              (e.currentTarget.parentElement as HTMLElement).classList.add("fallback-thumb");
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-muted/10">
            <ImageOff size={28} className="text-muted-foreground/30" />
          </div>
        )}
        {item.compareAtPrice && parseFloat(item.compareAtPrice) > parseFloat(item.price) && (
          <div className="absolute top-2 left-2 text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500 text-white tracking-wide">
            SALE
          </div>
        )}
        {!item.isAvailable && (
          <div className="absolute inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Unavailable</span>
          </div>
        )}
        {canEdit && (
          <button
            onClick={e => { e.preventDefault(); e.stopPropagation(); onEdit(item); }}
            className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-background/80 backdrop-blur-sm border border-border/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:bg-background"
          >
            <Edit2 size={11} />
          </button>
        )}
      </div>

      {/* Info */}
      <div className="p-4 flex-1 flex flex-col gap-2">
        <div className="flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">
            {isLC ? (item.alavontCategory || item.category) : item.category}
          </div>
          <div className="text-sm font-bold leading-snug line-clamp-2">
            {isLC ? (item.luciferCruzName || item.name) : (item.alavontName || item.name)}
          </div>
          {(isLC ? item.luciferCruzDescription : item.description) && (
            <div className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
              {isLC ? item.luciferCruzDescription : item.description}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between mt-1">
          <div className="flex items-baseline gap-1.5">
            <span
              className="text-base font-bold"
              style={isLC ? { color: "#DC143C" } : { color: "hsl(var(--primary))" }}
            >
              ${parseFloat(isLC && item.regularPrice ? item.regularPrice : item.price).toFixed(2)}
            </span>
          </div>
          {item.stockQuantity !== undefined && item.isAvailable && !isLC && (
            <span className={`text-[10px] font-mono ${item.stockQuantity === 0 ? "text-red-400" : "text-muted-foreground/70"}`}>
              {item.stockQuantity === 0 ? "OUT" : `${item.stockQuantity} avail`}
            </span>
          )}
        </div>

        <Link
          href={`/catalog/${item.id}`}
          className="mt-1 flex items-center justify-center gap-1.5 w-full text-xs font-semibold py-2.5 rounded-xl border transition-all"
          style={isLC
            ? { background: "linear-gradient(135deg, #DC143C, #8B0000)", color: "#fff", border: "none" }
            : { borderColor: "rgba(var(--primary), 0.3)", color: "hsl(var(--primary))" }}
          data-testid={`link-product-${item.id}`}
        >
          <ShoppingCart size={11} />
          {isLC ? "Order" : "View & Order"}
        </Link>
      </div>
    </div>
  );
}

function ItemFormFields({ form, setForm }: { form: any; setForm: (updater: (prev: any) => any) => void }) {
  const fields = [
    { label: "Name *", key: "name", type: "text" },
    { label: "Category *", key: "category", type: "text" },
    { label: "Price ($) *", key: "price", type: "number" },
    { label: "SKU", key: "sku", type: "text" },
    { label: "Stock Quantity", key: "stockQuantity", type: "number" },
    { label: "Image URL", key: "imageUrl", type: "url", placeholder: "https://example.com/image.jpg" },
  ];
  return (
    <>
      {fields.map(({ label, key, type, placeholder }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <Input
            type={type}
            value={form[key] ?? ""}
            onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
            placeholder={placeholder}
            className="rounded-xl h-9 text-sm bg-background/50"
          />
        </div>
      ))}
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Description</label>
        <textarea
          value={form.description ?? ""}
          onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
          className="w-full text-sm rounded-xl border border-border/50 bg-background/50 px-3 py-2 resize-none h-20 focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      </div>
      {form.imageUrl && (
        <div className="rounded-xl overflow-hidden h-32 bg-muted/20">
          <img src={form.imageUrl} alt="preview" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
        </div>
      )}
    </>
  );
}

function DualBrandFormFields({ form, setForm }: { form: any; setForm: (updater: (prev: any) => any) => void }) {
  return (
    <div className="space-y-3">
      <div className="text-[10px] font-bold uppercase tracking-widest text-blue-400 pt-1">Alavont Display Fields</div>
      {[
        { label: "Alavont Name", key: "alavontName" },
        { label: "Alavont Category", key: "alavontCategory" },
        { label: "Alavont Image URL", key: "alavontImageUrl" },
      ].map(({ label, key }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <Input value={form[key] ?? ""} onChange={e => setForm((p: any) => ({ ...p, [key]: e.target.value }))} className="rounded-xl h-9 text-sm bg-background/50" />
        </div>
      ))}
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Alavont Description</label>
        <textarea value={form.alavontDescription ?? ""} onChange={e => setForm((p: any) => ({ ...p, alavontDescription: e.target.value }))} className="w-full text-sm rounded-xl border border-border/50 bg-background/50 px-3 py-2 resize-none h-16 focus:outline-none focus:ring-1 focus:ring-primary/50" />
      </div>
      <div className="flex items-center gap-3 pt-1">
        <span className="text-xs text-muted-foreground">Alavont In Stock</span>
        <button onClick={() => setForm((p: any) => ({ ...p, alavontInStock: !p.alavontInStock }))} className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${form.alavontInStock !== false ? "bg-primary" : "bg-muted"}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${form.alavontInStock !== false ? "left-5" : "left-0.5"}`} />
        </button>
      </div>

      <div className="text-[10px] font-bold uppercase tracking-widest text-red-400 pt-2">Lucifer Cruz Merchant Fields</div>
      {[
        { label: "Lucifer Cruz Name", key: "luciferCruzName" },
        { label: "Lucifer Cruz Category", key: "luciferCruzCategory" },
        { label: "Lucifer Cruz Image URL", key: "luciferCruzImageUrl" },
      ].map(({ label, key }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <Input value={form[key] ?? ""} onChange={e => setForm((p: any) => ({ ...p, [key]: e.target.value }))} className="rounded-xl h-9 text-sm bg-background/50" />
        </div>
      ))}
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Lucifer Cruz Description</label>
        <textarea value={form.luciferCruzDescription ?? ""} onChange={e => setForm((p: any) => ({ ...p, luciferCruzDescription: e.target.value }))} className="w-full text-sm rounded-xl border border-border/50 bg-background/50 px-3 py-2 resize-none h-16 focus:outline-none focus:ring-1 focus:ring-primary/50" />
      </div>

      <div className="text-[10px] font-bold uppercase tracking-widest text-amber-400 pt-2">Merchant Routing</div>
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Processing Mode</label>
        <select value={form.merchantProcessingMode ?? "mapped_lucifer"} onChange={e => setForm((p: any) => ({ ...p, merchantProcessingMode: e.target.value }))} className="w-full text-sm rounded-xl border border-border/50 bg-background/50 px-3 py-2 h-9 focus:outline-none">
          <option value="mapped_lucifer">Mapped to Lucifer Cruz</option>
          <option value="woo_native">WooCommerce Native</option>
        </select>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">WooCommerce Managed</span>
        <button onClick={() => setForm((p: any) => ({ ...p, isWooManaged: !p.isWooManaged }))} className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${form.isWooManaged ? "bg-amber-500" : "bg-muted"}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${form.isWooManaged ? "left-5" : "left-0.5"}`} />
        </button>
      </div>
      {[
        { label: "WooCommerce Product ID", key: "wooProductId" },
        { label: "WooCommerce Variation ID", key: "wooVariationId" },
      ].map(({ label, key }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <Input value={form[key] ?? ""} onChange={e => setForm((p: any) => ({ ...p, [key]: e.target.value || null }))} className="rounded-xl h-9 text-sm bg-background/50" placeholder="Optional" />
        </div>
      ))}
      {[
        { label: "Lab Name", key: "labName" },
        { label: "Receipt Name", key: "receiptName" },
      ].map(({ label, key }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <Input value={form[key] ?? ""} onChange={e => setForm((p: any) => ({ ...p, [key]: e.target.value || null }))} className="rounded-xl h-9 text-sm bg-background/50" placeholder="Optional" />
        </div>
      ))}
    </div>
  );
}

function EditItemDialog({ item, open, onClose }: { item: any | null; open: boolean; onClose: () => void }) {
  const [showDualBrand, setShowDualBrand] = useState(false);
  const [form, setForm] = useState({
    name: item?.name || "",
    description: item?.description || "",
    price: item?.price?.toString() || "",
    category: item?.category || "",
    sku: item?.sku || "",
    imageUrl: item?.imageUrl || "",
    stockQuantity: item?.stockQuantity?.toString() || "0",
    isAvailable: item?.isAvailable ?? true,
    alavontName: item?.alavontName || "",
    alavontDescription: item?.alavontDescription || "",
    alavontCategory: item?.alavontCategory || "",
    alavontImageUrl: item?.alavontImageUrl || "",
    alavontInStock: item?.alavontInStock ?? true,
    luciferCruzName: item?.luciferCruzName || "",
    luciferCruzDescription: item?.luciferCruzDescription || "",
    luciferCruzImageUrl: item?.luciferCruzImageUrl || "",
    luciferCruzCategory: item?.luciferCruzCategory || "",
    merchantProcessingMode: item?.merchantProcessingMode || "mapped_lucifer",
    isWooManaged: item?.isWooManaged || false,
    wooProductId: item?.wooProductId || "",
    wooVariationId: item?.wooVariationId || "",
    labName: item?.labName || "",
    receiptName: item?.receiptName || "",
  });
  const updateMutation = useUpdateCatalogItem();
  const queryClient = useQueryClient();

  const handleSave = () => {
    if (!item) return;
    updateMutation.mutate(
      {
        id: item.id,
        data: {
          name: form.name,
          description: form.description || undefined,
          price: parseFloat(form.price),
          category: form.category,
          sku: form.sku || undefined,
          imageUrl: form.imageUrl || undefined,
          stockQuantity: parseInt(form.stockQuantity) || 0,
          isAvailable: form.isAvailable,
          alavontName: form.alavontName || undefined,
          alavontDescription: form.alavontDescription || undefined,
          alavontCategory: form.alavontCategory || undefined,
          alavontImageUrl: form.alavontImageUrl || undefined,
          alavontInStock: form.alavontInStock,
          luciferCruzName: form.luciferCruzName || null,
          luciferCruzDescription: form.luciferCruzDescription || null,
          luciferCruzImageUrl: form.luciferCruzImageUrl || null,
          luciferCruzCategory: form.luciferCruzCategory || null,
          merchantProcessingMode: form.merchantProcessingMode,
          isWooManaged: form.isWooManaged,
          wooProductId: form.wooProductId || null,
          wooVariationId: form.wooVariationId || null,
          labName: form.labName || null,
          receiptName: form.receiptName || null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCatalogItemsQueryKey() });
          onClose();
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-lg rounded-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold uppercase tracking-wider">Edit Item</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <ItemFormFields form={form} setForm={setForm} />
          <div className="flex items-center gap-3 pt-1">
            <span className="text-xs text-muted-foreground">Available for ordering</span>
            <button
              onClick={() => setForm(prev => ({ ...prev, isAvailable: !prev.isAvailable }))}
              className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${form.isAvailable ? "bg-primary" : "bg-muted"}`}
            >
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${form.isAvailable ? "left-5" : "left-0.5"}`} />
            </button>
          </div>
          <button
            onClick={() => setShowDualBrand(v => !v)}
            className="w-full text-xs font-semibold py-2 rounded-xl border border-border/40 text-muted-foreground hover:text-foreground transition-colors"
          >
            {showDualBrand ? "Hide" : "Show"} Dual-Brand & Merchant Fields
          </button>
          {showDualBrand && <DualBrandFormFields form={form} setForm={setForm} />}
          <Button className="w-full rounded-xl" onClick={handleSave} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddItemDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const emptyForm = { name: "", description: "", price: "", category: "", sku: "", imageUrl: "", stockQuantity: "0" };
  const [form, setForm] = useState(emptyForm);
  const createMutation = useCreateCatalogItem();
  const queryClient = useQueryClient();

  const handleCreate = () => {
    if (!form.name || !form.price || !form.category) return;
    createMutation.mutate(
      {
        data: {
          name: form.name,
          description: form.description || undefined,
          price: parseFloat(form.price),
          category: form.category,
          sku: form.sku || undefined,
          imageUrl: form.imageUrl || undefined,
          stockQuantity: parseInt(form.stockQuantity) || 0,
          isAvailable: true,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCatalogItemsQueryKey() });
          setForm(emptyForm);
          onClose();
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-lg rounded-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold uppercase tracking-wider">Add Menu Item</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <ItemFormFields form={form} setForm={setForm} />
          <Button
            className="w-full rounded-xl"
            onClick={handleCreate}
            disabled={createMutation.isPending || !form.name || !form.price || !form.category}
          >
            {createMutation.isPending ? "Adding..." : "Add to Menu"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Catalog() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [menuMode, setMenuMode] = useState<MenuMode>("alavont");
  const [editItem, setEditItem] = useState<any | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const canEdit = user?.role === "admin" || user?.role === "supervisor";

  const { data: categoriesRes } = useListCatalogCategories({ query: { queryKey: ["listCatalogCategories"] } });
  const { data, isLoading } = useListCatalogItems(
    { search, category: category !== "all" ? category : undefined, limit: 200, mode: menuMode === "lucifer" ? "lucifer" : "alavont" },
    { query: { queryKey: ["listCatalogItems", search, category, menuMode] } }
  );

  const isLC = menuMode === "lucifer";

  const allItems = data?.items ?? [];

  // In LC mode the API already filters to only items with luciferCruzName or woo-managed
  const displayItems = allItems;

  // Determine empty-state reason for better messaging
  const hasItemsInResponse = allItems.length > 0;
  const hiddenByLCFilter = isLC && hasItemsInResponse && displayItems.length === 0;
  const hiddenBySearchOrCategory = !isLC && hasItemsInResponse && displayItems.length === 0 && (!!search || category !== "all");
  const trulyEmpty = !hasItemsInResponse && !isLoading;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold tracking-tight"
            data-testid="text-title"
          >
            {isLC ? "Lucifer Cruz" : "Menu"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-subtitle">
            {isLC ? "Adult boutique items available for ordering" : "Browse and order from the Alavont catalog"}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canEdit && !isLC && (
            <Button size="sm" className="rounded-xl text-xs h-9" onClick={() => setAddOpen(true)} data-testid="button-add-product">
              <Plus size={13} className="mr-1.5" /> Add Item
            </Button>
          )}
        </div>
      </div>

      {/* Brand toggle */}
      <div className="inline-flex p-1 rounded-xl border border-border/40 bg-muted/10">
        <button
          onClick={() => setMenuMode("alavont")}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
            !isLC ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20" : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-alavont"
        >
          <FlaskConical size={12} />
          Alavont Therapeutics
        </button>
        <button
          onClick={() => setMenuMode("lucifer")}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
            isLC ? "text-white" : "text-muted-foreground hover:text-foreground"
          }`}
          style={isLC ? { background: "linear-gradient(135deg, #DC143C, #8B0000)", boxShadow: "0 4px 16px rgba(220,20,60,0.35)" } : {}}
          data-testid="tab-lucifer"
        >
          <Flame size={12} />
          Lucifer Cruz
        </button>
      </div>

      {/* LC branded banner */}
      {isLC && (
        <div
          className="rounded-2xl p-4 border flex items-center gap-3"
          style={{ borderColor: "rgba(220,20,60,0.2)", background: "rgba(220,20,60,0.04)" }}
        >
          <Flame size={18} style={{ color: "#DC143C", flexShrink: 0 }} />
          <p className="text-xs" style={{ color: "#C0C0C0" }}>
            Lucifer Cruz items ordered here are fulfilled through Alavont Therapeutics. All transactions are private and discreet.
          </p>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative min-w-[180px] max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 h-9 rounded-xl text-sm bg-background/50"
            data-testid="input-search"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {["all", ...(categoriesRes?.categories ?? [])].map(cat => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`px-3 py-1.5 text-xs rounded-xl font-semibold transition-all border ${
                category === cat
                  ? isLC
                    ? "text-white border-transparent"
                    : "bg-primary text-primary-foreground border-transparent shadow-sm shadow-primary/20"
                  : "border-border/40 text-muted-foreground hover:text-foreground"
              }`}
              style={category === cat && isLC ? { background: "linear-gradient(135deg, #DC143C, #8B0000)" } : {}}
            >
              {cat === "all" ? "All" : cat}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {[...Array(10)].map((_, i) => (
            <div key={i} className="aspect-square rounded-2xl bg-muted/20 animate-pulse" />
          ))}
        </div>
      ) : !displayItems.length ? (
        <div className="glass-card rounded-2xl flex flex-col items-center justify-center py-20 text-center px-6" data-testid="text-empty-state">
          {isLC ? (
            <Flame size={32} style={{ color: "#DC143C", marginBottom: 12 }} />
          ) : (
            <Package size={32} className="text-muted-foreground/40 mb-3" />
          )}

          {/* "Hidden by LC filter" message */}
          {hiddenByLCFilter && (
            <>
              <div className="text-sm font-semibold mb-1">Products exist but have no Lucifer Cruz names</div>
              <div className="text-xs text-muted-foreground max-w-xs">
                {allItems.length} product{allItems.length !== 1 ? "s" : ""} are in the database but none have a <code className="font-mono bg-muted/30 px-1 rounded">lucifer_cruz_name</code> assigned.
                {canEdit && " Re-import your CSV with the lucifer_cruz_name column populated, or check Catalog Debug."}
              </div>
            </>
          )}

          {/* "Search/category filter hiding items" message */}
          {hiddenBySearchOrCategory && (
            <>
              <div className="text-sm font-semibold mb-1">No items match this filter</div>
              <div className="text-xs text-muted-foreground max-w-xs">
                {allItems.length} product{allItems.length !== 1 ? "s" : ""} exist but none match the current search or category. Try clearing the filters.
              </div>
              <Button size="sm" variant="outline" className="mt-4 rounded-xl text-xs" onClick={() => { setSearch(""); setCategory("all"); }}>
                Clear Filters
              </Button>
            </>
          )}

          {/* "Truly empty — nothing in DB" message */}
          {trulyEmpty && !hiddenByLCFilter && !hiddenBySearchOrCategory && (
            <>
              <div className="text-sm font-semibold mb-1">
                {isLC ? "No Lucifer Cruz items found" : "No products imported"}
              </div>
              <div className="text-xs text-muted-foreground max-w-xs">
                {isLC
                  ? "Import the menu CSV with lucifer_cruz_name populated, or sync from WooCommerce."
                  : canEdit
                    ? "No products in the catalog yet. Import a CSV from the Import Menu page."
                    : "No products available right now. Check back soon."}
              </div>
              {canEdit && !isLC && (
                <Button size="sm" className="mt-5 rounded-xl" onClick={() => setAddOpen(true)}>
                  <Plus size={12} className="mr-1.5" /> Add First Item
                </Button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {displayItems.map((item: any) => (
            <CatalogItemCard
              key={item.id}
              item={item}
              canEdit={canEdit}
              onEdit={setEditItem}
              menuMode={menuMode}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      <EditItemDialog item={editItem} open={!!editItem} onClose={() => setEditItem(null)} />
      <AddItemDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
