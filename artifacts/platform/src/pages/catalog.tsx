import { useState, useEffect } from "react";
import {
  useListCatalogItems,
  useCreateCatalogItem,
  useUpdateCatalogItem,
  useGetCurrentUser,
  getListCatalogItemsQueryKey,
  type CatalogItem,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, Plus, Edit2, Package, ImageOff, ShoppingCart, FlaskConical, Flame, Trash } from "lucide-react";
import { useBrand } from "@/contexts/BrandContext";
import { CatalogNotice } from "@/components/CatalogNotice";
import { Link } from "wouter";
import { normalizeNotificationRole } from "@/hooks/usePushNotifications";
import { useAuth } from "@clerk/react";

type MenuMode = "alavont" | "lucifer";

const LC_MAIN_CATEGORIES = [
  "Anal Play",
  "Apparel & Accessories",
  "Cock & Ball",
  "Kink & Fetish",
  "Self Care & Ambiance",
  "Couples Play",
  "Membership",
];

const DEFAULT_CATALOG_BANNERS = ["/banners/banner1.png", "/banners/banner2.png", "/banners/banner3.png"];

type ExtendedCatalogItem = CatalogItem & {
  stockUnit?: string | null;
  luciferCruzName?: string | null;
  luciferCruzCategory?: string | null;
  luciferCruzImageUrl?: string | null;
  luciferCruzDescription?: string | null;
  alavontName?: string | null;
  alavontCategory?: string | null;
  alavontImageUrl?: string | null;
  alavontDescription?: string | null;
  alavontInStock?: boolean | null;
  merchantProcessingMode?: string | null;
  isWooManaged?: boolean;
  wooProductId?: string | null;
  wooVariationId?: string | null;
  labName?: string | null;
  receiptName?: string | null;
  regularPrice?: string | number | null;
  homiePrice?: string | number | null;
  displayName?: string | null;
  displayDescription?: string | null;
  displayCategory?: string | null;
  displayImage?: string | null;
  merchantBrandName?: string | null;
  marketingCopy?: string | null;
  customerSafeName?: string | null;
  customerSafeDescription?: string | null;
  upsellCopy?: string | null;
  promoBadges?: string[];
  mediaGallery?: Array<{ type?: "image" | "video"; src: string; alt?: string | null }>;
  isFeatured?: boolean;
  isSaleFeatured?: boolean;
};

type MediaFormEntry = { type: "image" | "video"; src: string; alt: string };

interface CatalogItemForm {
  name: string;
  description: string;
  price: string;
  compareAtPrice: string;
  regularPrice: string;
  homiePrice: string;
  category: string;
  sku: string;
  imageUrl: string;
  stockQuantity: string;
  stockUnit: string;
  isAvailable: boolean;
  alavontName: string;
  alavontDescription: string;
  alavontCategory: string;
  alavontImageUrl: string;
  alavontInStock: boolean;
  luciferCruzName: string;
  luciferCruzDescription: string;
  luciferCruzImageUrl: string;
  luciferCruzCategory: string;
  merchantProcessingMode: string;
  isWooManaged: boolean;
  wooProductId: string;
  wooVariationId: string;
  labName: string;
  receiptName: string;
  isFeatured: boolean;
  isSaleFeatured: boolean;
  mediaGallery: MediaFormEntry[];
  displayName: string;
  displayDescription: string;
  displayCategory: string;
  displayImage: string;
  merchantBrandName: string;
  marketingCopy: string;
  customerSafeName: string;
  customerSafeDescription: string;
  upsellCopy: string;
  promoBadges: string;
}

type StringFormKey = {
  [K in keyof CatalogItemForm]: CatalogItemForm[K] extends string ? K : never;
}[keyof CatalogItemForm];

function CatalogItemCard({
  item,
  canEdit,
  onEdit,
  menuMode,
}: {
  item: ExtendedCatalogItem;
  canEdit: boolean;
  onEdit: (item: ExtendedCatalogItem) => void;
  menuMode: MenuMode;
}) {
  const isLC = menuMode === "lucifer";
  const [imgError, setImgError] = useState(false);
  const displayName = isLC ? (item.luciferCruzName || item.name) : (item.alavontName || item.name);
  const media = (item.mediaGallery ?? []).filter((entry) => entry.src?.trim());
  const primaryImage = isLC
    ? (item.luciferCruzImageUrl?.trim() || media[0]?.src?.trim() || item.imageUrl?.trim() || null)
    : (item.imageUrl?.trim() || item.alavontImageUrl?.trim() || media[0]?.src?.trim() || null);
  const hasSale = item.isSaleFeatured || (item.compareAtPrice && Number(item.compareAtPrice) > Number(item.price));

  return (
    <div
      className={`electric-catalog-card glass-card rounded-2xl overflow-hidden flex flex-col group cursor-pointer${isLC ? " lc-card" : ""}`}
      style={isLC ? { borderColor: "rgba(220,20,60,0.2)" } : { borderColor: "rgba(59,130,246,0.12)" }}
      data-testid={`card-product-${item.id}`}
    >
      {/* Thumbnail */}
      <div className="relative aspect-square overflow-hidden" style={{ background: isLC ? "#0A0000" : undefined }}>
        {primaryImage && !imgError ? (
          <>
            <img
              src={primaryImage}
              alt={displayName}
              className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 ${media.length > 1 ? "group-hover:opacity-0" : ""}`}
              onError={() => setImgError(true)}
            />
            {media.length > 1 && (
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                {media.slice(0, 4).map((entry, index) => (
                  entry.type === "video" ? (
                    <video
                      key={entry.src}
                      src={entry.src}
                      muted
                      loop
                      playsInline
                      autoPlay
                      className="absolute inset-0 w-full h-full object-cover catalog-card-media-frame"
                      style={{ animationDelay: `${index * 1.4}s` }}
                    />
                  ) : (
                    <img
                      key={entry.src}
                      src={entry.src}
                      alt={entry.alt || displayName}
                      className="absolute inset-0 w-full h-full object-cover catalog-card-media-frame"
                      style={{ animationDelay: `${index * 1.4}s` }}
                    />
                  )
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-muted/10" data-testid="image-placeholder">
            <ImageOff size={28} className="text-muted-foreground/30" />
          </div>
        )}
        {hasSale && (
          <div className="absolute top-2 left-2 text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500 text-white tracking-wide">
            SALE
          </div>
        )}
        {item.isFeatured && (
          <div className="absolute top-2 right-2 text-[9px] font-bold px-2 py-0.5 rounded-full bg-blue-600 text-white tracking-wide">
            FEATURED
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
            {isLC ? (item.luciferCruzCategory || item.category) : item.category}
          </div>
          <div className="text-sm font-bold leading-snug line-clamp-2">
            {displayName}
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
              ${parseFloat(String(isLC && item.regularPrice ? item.regularPrice : item.price)).toFixed(2)}
            </span>
          </div>
          {item.stockQuantity !== undefined && item.isAvailable && !isLC && (
            <span className={`text-[10px] font-mono ${item.stockQuantity === 0 ? "text-red-400" : "text-muted-foreground/70"}`}>
              {item.stockQuantity === 0 ? "OUT" : `${item.stockQuantity} avail`}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 mt-1">
          <Link
            href={`/orders/new?item=${item.id}`}
            className="flex items-center justify-center gap-1.5 w-full text-xs font-semibold py-2.5 rounded-xl transition-all"
            style={isLC
              ? { background: "linear-gradient(135deg, #DC143C, #8B0000)", color: "#fff" }
              : { background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
            data-testid={`link-buy-now-${item.id}`}
          >
            <ShoppingCart size={11} />
            Add to Cart
          </Link>
          <Link
            href={`/catalog/${item.id}`}
            className="flex items-center justify-center w-full text-xs font-semibold py-2.5 rounded-xl border transition-all"
            style={isLC
              ? { borderColor: "rgba(220,20,60,0.4)", color: "#FCA5A5" }
              : { borderColor: "rgba(var(--primary), 0.3)", color: "hsl(var(--primary))" }}
            data-testid={`link-product-${item.id}`}
          >
            Details
          </Link>
        </div>
      </div>
    </div>
  );
}

function ItemFormFields({ form, setForm }: { form: CatalogItemForm; setForm: (updater: (prev: CatalogItemForm) => CatalogItemForm) => void }) {
  const fields: Array<{ label: string; key: StringFormKey; type: string; placeholder?: string }> = [
    { label: "Alavont Display Name *", key: "alavontName", type: "text" },
    { label: "Safe / Checkout Name", key: "customerSafeName", type: "text", placeholder: "Name shown at checkout (defaults to Alavont name)" },
    { label: "Category *", key: "category", type: "text" },
    { label: "Price ($) *", key: "price", type: "number" },
    { label: "Compare-at / Sale Price ($)", key: "compareAtPrice", type: "number" },
    { label: "Regular Price ($)", key: "regularPrice", type: "number" },
    { label: "Homie Price ($)", key: "homiePrice", type: "number" },
    { label: "SKU", key: "sku", type: "text" },
    { label: "Stock Quantity", key: "stockQuantity", type: "number" },
    { label: "Stock Unit", key: "stockUnit", type: "text", placeholder: "#, g, oz, pkg" },
    { label: "Image URL", key: "imageUrl", type: "url", placeholder: "https://example.com/image.jpg" },
    { label: "Internal Name (legacy)", key: "name", type: "text" },
  ];
  return (
    <>
      {fields.map(({ label, key, type, placeholder }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <Input
            type={type}
            value={form[key]}
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

function normalizeMediaForSave(mediaGallery: MediaFormEntry[], imageUrl: string) {
  const rows = mediaGallery
    .map(entry => ({
      type: entry.type,
      src: entry.src.trim(),
      alt: entry.alt.trim() || null,
    }))
    .filter(entry => entry.src);
  const primary = imageUrl.trim();
  if (primary && !rows.some(entry => entry.src === primary)) {
    rows.unshift({ type: "image" as const, src: primary, alt: null });
  }
  return rows;
}

function MediaGalleryFields({ form, setForm }: { form: CatalogItemForm; setForm: (updater: (prev: CatalogItemForm) => CatalogItemForm) => void }) {
  const addMediaRow = () => {
    setForm(prev => ({ ...prev, mediaGallery: [...prev.mediaGallery, { type: "image", src: "", alt: "" }] }));
  };

  const updateMediaRow = (index: number, patch: Partial<MediaFormEntry>) => {
    setForm(prev => ({
      ...prev,
      mediaGallery: prev.mediaGallery.map((entry, i) => i === index ? { ...entry, ...patch } : entry),
    }));
  };

  const removeMediaRow = (index: number) => {
    setForm(prev => ({ ...prev, mediaGallery: prev.mediaGallery.filter((_, i) => i !== index) }));
  };

  const handleUpload = (files: FileList | null) => {
    if (!files?.length) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const src = typeof reader.result === "string" ? reader.result : "";
        if (!src) return;
        setForm(prev => ({
          ...prev,
          mediaGallery: [
            ...prev.mediaGallery,
            {
              type: file.type.startsWith("video/") ? "video" : "image",
              src,
              alt: file.name.replace(/\.[^.]+$/, ""),
            },
          ],
        }));
      };
      reader.readAsDataURL(file);
    });
  };

  return (
    <div className="space-y-3 pt-2 border-t border-border/30">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-primary">Images & Videos</div>
          <p className="text-[11px] text-muted-foreground mt-0.5">Add product media URLs or upload files for the product card and detail gallery.</p>
        </div>
        <Button type="button" variant="outline" size="sm" className="rounded-xl text-xs" onClick={addMediaRow}>
          Add URL
        </Button>
      </div>

      <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-border/50 bg-muted/10 px-3 py-4 text-xs font-semibold text-muted-foreground hover:text-foreground">
        Upload images/videos
        <input
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={e => {
            handleUpload(e.target.files);
            e.currentTarget.value = "";
          }}
        />
      </label>

      <div className="space-y-3">
        {form.mediaGallery.map((entry, index) => (
          <div key={`${entry.src}-${index}`} className="rounded-xl border border-border/40 bg-background/40 p-3 space-y-2">
            <div className="grid grid-cols-[88px_1fr_auto] gap-2">
              <select
                value={entry.type}
                onChange={e => updateMediaRow(index, { type: e.target.value === "video" ? "video" : "image" })}
                className="h-9 rounded-lg border border-border/50 bg-background/50 px-2 text-xs"
              >
                <option value="image">Image</option>
                <option value="video">Video</option>
              </select>
              <Input
                value={entry.src}
                onChange={e => updateMediaRow(index, { src: e.target.value })}
                className="h-9 rounded-lg text-xs bg-background/50"
                placeholder="https://... or uploaded data URL"
              />
              <Button type="button" variant="ghost" size="sm" className="h-9 px-2 rounded-lg text-muted-foreground" onClick={() => removeMediaRow(index)}>
                <Trash size={13} />
              </Button>
            </div>
            <Input
              value={entry.alt}
              onChange={e => updateMediaRow(index, { alt: e.target.value })}
              className="h-8 rounded-lg text-xs bg-background/50"
              placeholder="Alt text / label"
            />
            {entry.src && (
              <div className="h-28 rounded-lg overflow-hidden bg-muted/20">
                {entry.type === "video" ? (
                  <video src={entry.src} muted controls className="h-full w-full object-cover" />
                ) : (
                  <img src={entry.src} alt={entry.alt || "media preview"} className="h-full w-full object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function emptyCatalogForm(): CatalogItemForm {
  return {
    name: "",
    description: "",
    price: "",
    compareAtPrice: "",
    regularPrice: "",
    homiePrice: "",
    category: "",
    sku: "",
    imageUrl: "",
    stockQuantity: "0",
    stockUnit: "",
    isAvailable: true,
    alavontName: "",
    alavontDescription: "",
    alavontCategory: "",
    alavontImageUrl: "",
    alavontInStock: true,
    luciferCruzName: "",
    luciferCruzDescription: "",
    luciferCruzImageUrl: "",
    luciferCruzCategory: "",
    merchantProcessingMode: "mapped_lucifer",
    isWooManaged: false,
    wooProductId: "",
    wooVariationId: "",
    labName: "",
    receiptName: "",
    isFeatured: false,
    isSaleFeatured: false,
    mediaGallery: [],
    displayName: "",
    displayDescription: "",
    displayCategory: "",
    displayImage: "",
    merchantBrandName: "",
    marketingCopy: "",
    customerSafeName: "",
    customerSafeDescription: "",
    upsellCopy: "",
    promoBadges: "",
  };
}

function formFromItem(item: ExtendedCatalogItem | null): CatalogItemForm {
  const base = emptyCatalogForm();
  if (!item) return base;
  return {
    ...base,
    name: item.name || "",
    description: item.description || "",
    price: item.price?.toString() || "",
    compareAtPrice: item.compareAtPrice?.toString() || "",
    regularPrice: item.regularPrice?.toString() || "",
    homiePrice: item.homiePrice?.toString() || "",
    category: item.category || "",
    sku: item.sku || "",
    imageUrl: item.imageUrl || "",
    stockQuantity: item.stockQuantity?.toString() || "0",
    stockUnit: (item as ExtendedCatalogItem & { stockUnit?: string | null }).stockUnit || "",
    isAvailable: item.isAvailable ?? true,
    alavontName: item.alavontName || "",
    alavontDescription: item.alavontDescription || "",
    alavontCategory: item.alavontCategory || "",
    alavontImageUrl: item.alavontImageUrl || "",
    alavontInStock: item.alavontInStock ?? true,
    luciferCruzName: item.luciferCruzName || "",
    luciferCruzDescription: item.luciferCruzDescription || "",
    luciferCruzImageUrl: item.luciferCruzImageUrl || "",
    luciferCruzCategory: item.luciferCruzCategory || "",
    merchantProcessingMode: item.merchantProcessingMode || "mapped_lucifer",
    isWooManaged: item.isWooManaged || false,
    wooProductId: item.wooProductId || "",
    wooVariationId: item.wooVariationId || "",
    labName: item.labName || "",
    receiptName: item.receiptName || "",
    isFeatured: item.isFeatured || false,
    isSaleFeatured: item.isSaleFeatured || false,
    mediaGallery: (item.mediaGallery ?? []).map(entry => ({
      type: entry.type === "video" ? "video" : "image",
      src: entry.src,
      alt: entry.alt || "",
    })),
    displayName: item.displayName || "",
    displayDescription: item.displayDescription || "",
    displayCategory: item.displayCategory || "",
    displayImage: item.displayImage || "",
    merchantBrandName: item.merchantBrandName || "",
    marketingCopy: item.marketingCopy || "",
    customerSafeName: item.customerSafeName || "",
    customerSafeDescription: item.customerSafeDescription || "",
    upsellCopy: item.upsellCopy || "",
    promoBadges: (item.promoBadges ?? []).join(", "),
  };
}

function handleImageFileUpload(file: File, onUrl: (url: string) => void) {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === "string") onUrl(reader.result);
  };
  reader.readAsDataURL(file);
}

function ImageUploadField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          className="rounded-xl h-9 text-sm bg-background/50 flex-1"
          placeholder={placeholder ?? "https://example.com/image.jpg"}
        />
        <label className="h-9 px-3 flex items-center cursor-pointer rounded-xl border border-border/50 bg-background/50 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0">
          Upload
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) handleImageFileUpload(f, onChange);
              e.currentTarget.value = "";
            }}
          />
        </label>
      </div>
      {value && (
        <div className="mt-1.5 h-20 rounded-xl overflow-hidden bg-muted/20">
          <img src={value} alt="preview" className="w-full h-full object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
        </div>
      )}
    </div>
  );
}

function DualBrandFormFields({ form, setForm }: { form: CatalogItemForm; setForm: (updater: (prev: CatalogItemForm) => CatalogItemForm) => void }) {
  const alavontStringFields: Array<{ label: string; key: StringFormKey }> = [
    { label: "Alavont Name", key: "alavontName" },
    { label: "Alavont Category", key: "alavontCategory" },
  ];
  const luciferStringFields: Array<{ label: string; key: StringFormKey }> = [
    { label: "Lucifer Cruz Name", key: "luciferCruzName" },
    { label: "Lucifer Cruz Category", key: "luciferCruzCategory" },
    { label: "Lucifer Cruz Image URL", key: "luciferCruzImageUrl" },
  ];
  const wooStringFields: Array<{ label: string; key: StringFormKey }> = [
    { label: "WooCommerce Product ID", key: "wooProductId" },
    { label: "WooCommerce Variation ID", key: "wooVariationId" },
  ];
  const metaStringFields: Array<{ label: string; key: StringFormKey }> = [
    { label: "Merchant SKU", key: "labName" },
    { label: "Receipt Name", key: "receiptName" },
  ];
  return (
    <div className="space-y-3">
      <div className="text-[10px] font-bold uppercase tracking-widest text-blue-400 pt-1">Alavont Display Fields</div>
      {alavontStringFields.map(({ label, key }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <Input value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} className="rounded-xl h-9 text-sm bg-background/50" />
        </div>
      ))}
      <ImageUploadField
        label="Alavont Image URL"
        value={form.alavontImageUrl}
        onChange={v => setForm(p => ({ ...p, alavontImageUrl: v }))}
      />
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Alavont Description</label>
        <textarea value={form.alavontDescription ?? ""} onChange={e => setForm(p => ({ ...p, alavontDescription: e.target.value }))} className="w-full text-sm rounded-xl border border-border/50 bg-background/50 px-3 py-2 resize-none h-16 focus:outline-none focus:ring-1 focus:ring-primary/50" />
      </div>
      <div className="flex items-center gap-3 pt-1">
        <span className="text-xs text-muted-foreground">Alavont In Stock</span>
        <button onClick={() => setForm(p => ({ ...p, alavontInStock: !p.alavontInStock }))} className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${form.alavontInStock !== false ? "bg-primary" : "bg-muted"}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${form.alavontInStock !== false ? "left-5" : "left-0.5"}`} />
        </button>
      </div>

      <div className="text-[10px] font-bold uppercase tracking-widest text-red-400 pt-2">Lucifer Cruz Merchant Fields</div>
      {luciferStringFields.map(({ label, key }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <Input value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} className="rounded-xl h-9 text-sm bg-background/50" />
        </div>
      ))}
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Lucifer Cruz Description</label>
        <textarea value={form.luciferCruzDescription ?? ""} onChange={e => setForm(p => ({ ...p, luciferCruzDescription: e.target.value }))} className="w-full text-sm rounded-xl border border-border/50 bg-background/50 px-3 py-2 resize-none h-16 focus:outline-none focus:ring-1 focus:ring-primary/50" />
      </div>

      <div className="text-[10px] font-bold uppercase tracking-widest text-amber-400 pt-2">Merchant Routing</div>
      <div>
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Processing Mode</label>
        <select value={form.merchantProcessingMode ?? "mapped_lucifer"} onChange={e => setForm(p => ({ ...p, merchantProcessingMode: e.target.value }))} className="w-full text-sm rounded-xl border border-border/50 bg-background/50 px-3 py-2 h-9 focus:outline-none">
          <option value="mapped_lucifer">Mapped to Lucifer Cruz</option>
          <option value="woo_native">WooCommerce Native</option>
        </select>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">WooCommerce Managed</span>
        <button onClick={() => setForm(p => ({ ...p, isWooManaged: !p.isWooManaged }))} className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${form.isWooManaged ? "bg-amber-500" : "bg-muted"}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${form.isWooManaged ? "left-5" : "left-0.5"}`} />
        </button>
      </div>
      {wooStringFields.map(({ label, key }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <Input value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} className="rounded-xl h-9 text-sm bg-background/50" placeholder="Optional" />
        </div>
      ))}
      {metaStringFields.map(({ label, key }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <Input value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} className="rounded-xl h-9 text-sm bg-background/50" placeholder="Optional" />
        </div>
      ))}
    </div>
  );
}

function CheckoutPresentationFields({ form, setForm }: { form: CatalogItemForm; setForm: (updater: (prev: CatalogItemForm) => CatalogItemForm) => void }) {
  const fields: Array<{ label: string; key: StringFormKey; placeholder?: string }> = [
    { label: "Converted Display Name", key: "displayName" },
    { label: "Converted Category", key: "displayCategory" },
    { label: "Merchant Brand Name", key: "merchantBrandName" },
    { label: "Customer Safe Name", key: "customerSafeName" },
    { label: "Promo Badges", key: "promoBadges", placeholder: "Comma-separated badges" },
  ];
  return (
    <div className="space-y-3 pt-2 border-t border-border/30">
      <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">Checkout Presentation</div>
      {fields.map(({ label, key, placeholder }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <Input value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} className="rounded-xl h-9 text-sm bg-background/50" placeholder={placeholder} />
        </div>
      ))}
      <ImageUploadField
        label="Converted / Safe Image URL"
        value={form.displayImage}
        onChange={v => setForm(p => ({ ...p, displayImage: v }))}
      />
      {[
        { label: "Converted Description", key: "displayDescription" as const },
        { label: "Marketing Copy", key: "marketingCopy" as const },
        { label: "Customer Safe Description", key: "customerSafeDescription" as const },
        { label: "Upsell Copy", key: "upsellCopy" as const },
      ].map(({ label, key }) => (
        <div key={key}>
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">{label}</label>
          <textarea value={form[key] ?? ""} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} className="w-full text-sm rounded-xl border border-border/50 bg-background/50 px-3 py-2 resize-none h-16 focus:outline-none focus:ring-1 focus:ring-primary/50" />
        </div>
      ))}
    </div>
  );
}

function EditItemDialog({ item, open, onClose }: { item: ExtendedCatalogItem | null; open: boolean; onClose: () => void }) {
  const [showDualBrand, setShowDualBrand] = useState(false);
  const [showPresentation, setShowPresentation] = useState(false);
  const [form, setForm] = useState<CatalogItemForm>(() => formFromItem(item));
  const updateMutation = useUpdateCatalogItem();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (open) {
      setForm(formFromItem(item));
      setShowDualBrand(false);
      setShowPresentation(false);
    }
  }, [item, open]);

  const handleSave = () => {
    if (!item) return;
    const mediaGallery = normalizeMediaForSave(form.mediaGallery, form.imageUrl);
    updateMutation.mutate(
      {
        id: item.id,
        data: {
          name: form.name,
          description: form.description || undefined,
          price: parseFloat(form.price),
          compareAtPrice: form.compareAtPrice ? parseFloat(form.compareAtPrice) : undefined,
          regularPrice: form.regularPrice ? parseFloat(form.regularPrice) : null,
          homiePrice: form.homiePrice ? parseFloat(form.homiePrice) : null,
          category: form.category,
          sku: form.sku || undefined,
          imageUrl: form.imageUrl || undefined,
          mediaGallery,
          stockQuantity: parseInt(form.stockQuantity) || 0,
          stockUnit: form.stockUnit || undefined,
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
          isFeatured: form.isFeatured,
          isSaleFeatured: form.isSaleFeatured,
          displayName: form.displayName || null,
          displayDescription: form.displayDescription || null,
          displayCategory: form.displayCategory || null,
          displayImage: form.displayImage || null,
          merchantBrandName: form.merchantBrandName || null,
          marketingCopy: form.marketingCopy || null,
          customerSafeName: form.customerSafeName || null,
          customerSafeDescription: form.customerSafeDescription || null,
          upsellCopy: form.upsellCopy || null,
          promoBadges: form.promoBadges.split(",").map(b => b.trim()).filter(Boolean),
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
          <DialogTitle className="text-sm font-bold uppercase tracking-wider">Edit Item{item ? ` #${item.id}` : ""}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <ItemFormFields form={form} setForm={setForm} />
          <MediaGalleryFields form={form} setForm={setForm} />
          <div className="flex items-center gap-3 pt-1">
            <span className="text-xs text-muted-foreground">Available for ordering</span>
            <button
              onClick={() => setForm(prev => ({ ...prev, isAvailable: !prev.isAvailable }))}
              className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${form.isAvailable ? "bg-primary" : "bg-muted"}`}
            >
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${form.isAvailable ? "left-5" : "left-0.5"}`} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setForm(prev => ({ ...prev, isFeatured: !prev.isFeatured }))}
              className={`text-xs font-semibold py-2 rounded-xl border transition-colors ${form.isFeatured ? "bg-blue-600 text-white border-blue-600" : "border-border/40 text-muted-foreground"}`}
            >
              Featured
            </button>
            <button
              type="button"
              onClick={() => setForm(prev => ({ ...prev, isSaleFeatured: !prev.isSaleFeatured }))}
              className={`text-xs font-semibold py-2 rounded-xl border transition-colors ${form.isSaleFeatured ? "bg-emerald-600 text-white border-emerald-600" : "border-border/40 text-muted-foreground"}`}
            >
              Sale Item
            </button>
          </div>
          <button
            onClick={() => setShowDualBrand(v => !v)}
            className="w-full text-xs font-semibold py-2 rounded-xl border border-border/40 text-muted-foreground hover:text-foreground transition-colors"
          >
            {showDualBrand ? "Hide" : "Show"} Dual-Brand & Merchant Fields
          </button>
          {showDualBrand && <DualBrandFormFields form={form} setForm={setForm} />}
          <button
            onClick={() => setShowPresentation(v => !v)}
            className="w-full text-xs font-semibold py-2 rounded-xl border border-border/40 text-muted-foreground hover:text-foreground transition-colors"
          >
            {showPresentation ? "Hide" : "Show"} Checkout Presentation Fields
          </button>
          {showPresentation && <CheckoutPresentationFields form={form} setForm={setForm} />}
          <Button className="w-full rounded-xl" onClick={handleSave} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddItemDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const emptyForm = emptyCatalogForm();
  const [form, setForm] = useState<CatalogItemForm>(emptyForm);
  const createMutation = useCreateCatalogItem();
  const queryClient = useQueryClient();

  const handleCreate = () => {
    if (!form.alavontName || !form.price || !form.category) return;
    const mediaGallery = normalizeMediaForSave(form.mediaGallery, form.imageUrl);
    createMutation.mutate(
      {
        data: {
          name: form.name || form.alavontName,
          description: form.description || undefined,
          price: parseFloat(form.price),
          compareAtPrice: form.compareAtPrice ? parseFloat(form.compareAtPrice) : undefined,
          regularPrice: form.regularPrice ? parseFloat(form.regularPrice) : null,
          homiePrice: form.homiePrice ? parseFloat(form.homiePrice) : null,
          category: form.category,
          sku: form.sku || undefined,
          imageUrl: form.imageUrl || undefined,
          mediaGallery,
          stockQuantity: parseInt(form.stockQuantity) || 0,
          stockUnit: form.stockUnit || undefined,
          isAvailable: true,
          isFeatured: form.isFeatured,
          isSaleFeatured: form.isSaleFeatured,
          alavontName: form.alavontName || undefined,
          alavontDescription: form.alavontDescription || undefined,
          alavontCategory: form.alavontCategory || undefined,
          alavontImageUrl: form.alavontImageUrl || undefined,
          alavontInStock: form.alavontInStock,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCatalogItemsQueryKey() });
          setForm(emptyCatalogForm());
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
          <MediaGalleryFields form={form} setForm={setForm} />
          <Button
            className="w-full rounded-xl"
            onClick={handleCreate}
            disabled={createMutation.isPending || !form.alavontName || !form.price || !form.category}
          >
            {createMutation.isPending ? "Adding..." : "Add to Menu"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Catalog() {
  const { getToken } = useAuth();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [bannerImages, setBannerImages] = useState(DEFAULT_CATALOG_BANNERS);
  const { brand, setBrand } = useBrand();
  const [menuMode, setMenuMode] = useState<MenuMode>(() =>
    brand === "lucifer_cruz" ? "lucifer" : "alavont"
  );
  const [editItem, setEditItem] = useState<ExtendedCatalogItem | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    setBrand(menuMode === "lucifer" ? "lucifer_cruz" : "alavont");
  }, [menuMode, setBrand]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch("/api/admin/settings", token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && Array.isArray(body.catalogBannerImages) && body.catalogBannerImages.length) {
          setBannerImages(body.catalogBannerImages);
        }
      } catch {
        // Admin settings are optional for storefront rendering.
      }
    })();
    return () => { cancelled = true; };
  }, [getToken]);

  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const userRole = normalizeNotificationRole(user?.role);
  const canEdit = userRole === "global_admin" || userRole === "admin";

  const { data: categoriesRes } = useQuery({
    queryKey: ["listCatalogCategories", menuMode],
    queryFn: async (): Promise<{ categories: string[] }> => {
      const token = await getToken();
      const res = await fetch(`/api/catalog/categories?mode=${menuMode}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      if (!res.ok) throw new Error(`Could not load categories (${res.status})`);
      return res.json() as Promise<{ categories: string[] }>;
    },
  });
  const { data, isLoading } = useListCatalogItems(
    { search, category: category !== "all" ? category : undefined, limit: 200, mode: menuMode === "lucifer" ? "lucifer" : "alavont" },
    { query: { queryKey: ["listCatalogItems", search, category, menuMode] } }
  );

  const isLC = menuMode === "lucifer";
  const categories = ["all", ...(categoriesRes?.categories ?? [])]
    .filter(cat => cat === "all" || (isLC ? LC_MAIN_CATEGORIES.includes(cat) : true))
    .sort((a, b) => {
      if (a === "all") return -1;
      if (b === "all") return 1;
      const ai = LC_MAIN_CATEGORIES.indexOf(a);
      const bi = LC_MAIN_CATEGORIES.indexOf(b);
      if (isLC && ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.localeCompare(b);
    });

  const allItems = data?.items ?? [];

  // In LC mode the API returns only WooCommerce-synced Lucifer Cruz products.
  // Alavont rows can still carry LC mapping fields for payment conversion,
  // but those mapped fields do not make them Lucifer Cruz storefront items.
  const displayItems = allItems;

  // Determine empty-state reason for better messaging
  const hasItemsInResponse = allItems.length > 0;
  const hiddenByLCFilter = isLC && hasItemsInResponse && displayItems.length === 0;
  const hiddenBySearchOrCategory = !isLC && hasItemsInResponse && displayItems.length === 0 && (!!search || category !== "all");
  const trulyEmpty = !hasItemsInResponse && !isLoading;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Hero/header: banner sits behind the title and brand buttons. */}
      <div className="relative overflow-hidden rounded-3xl border border-border/30 min-h-[380px] md:min-h-[460px] catalog-hero">
        {!isLC && (
          <div className="absolute inset-0 z-0">
            {bannerImages.map((src, index) => (
              <img
                key={src}
                src={src}
                alt=""
                className="absolute inset-0 h-full w-full object-contain catalog-hero-frame"
                style={{ animationDelay: `${index * 10}s` }}
              />
            ))}
            <div className="absolute inset-0 bg-gradient-to-b from-background/35 via-background/10 to-background/80" />
            <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-background via-background/55 to-transparent" />
          </div>
        )}

        <div className="relative z-10 flex min-h-[380px] md:min-h-[460px] flex-col justify-between gap-6 p-5 md:p-8">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div className="flex items-center gap-2 shrink-0 relative z-20">
              {canEdit && !isLC && (
                <Button size="sm" className="rounded-xl text-xs h-9 shadow-lg" onClick={() => setAddOpen(true)} data-testid="button-add-product">
                  <Plus size={13} className="mr-1.5" /> Add Item
                </Button>
              )}
            </div>
          </div>

          <div className="relative z-20 inline-flex w-fit p-1 rounded-xl border border-border/40 bg-background/70 backdrop-blur-md shadow-xl">
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
        </div>
      </div>

      {/* LC branded banner */}
      {isLC && (
        <div
          className="rounded-2xl p-4 border flex items-center gap-3"
          style={{ borderColor: "rgba(220,20,60,0.2)", background: "rgba(220,20,60,0.04)" }}
        >
          <Flame size={18} style={{ color: "#DC143C", flexShrink: 0 }} />
          <p className="text-xs" style={{ color: "#C0C0C0" }}>
            All transactions are private and discreet.
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
          {categories.map(cat => (
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
          {displayItems.map((item) => (
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

      {!isLC && (
        <div className="rounded-2xl p-4 border border-blue-500/15 bg-blue-500/5">
          <p className="text-xs text-muted-foreground">
            Alavont Therapeutics items ordered here are fulfilled through Lucifer Cruz. All transactions are private and discreet.
          </p>
        </div>
      )}

      <CatalogNotice className="mt-4" />

      {/* Dialogs */}
      <EditItemDialog item={editItem} open={!!editItem} onClose={() => setEditItem(null)} />
      <AddItemDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
