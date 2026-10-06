import { useBrand } from "@/contexts/BrandContext";
import { visibleSupplierAttribution } from "@/lib/branding";

interface CatalogNoticeProps {
  className?: string;
}

export function CatalogNotice({ className = "" }: CatalogNoticeProps) {
  const { brand, branding } = useBrand();
  const attribution = brand === "lucifer_cruz" ? visibleSupplierAttribution(branding) : null;
  const notice = brand === "lucifer_cruz" ? branding.supplier.disclaimer : branding.customer.termsDisclaimer;

  if (!attribution && !notice) return null;

  return (
    <aside
      role="note"
      aria-label="Merchant disclaimer"
      data-testid="catalog-notice"
      className={`w-full rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 text-xs italic text-muted-foreground leading-relaxed ${className}`}
    >
      {attribution && <p>{attribution}</p>}
      {notice && <p className={attribution ? "mt-1" : ""}>{notice}</p>}
    </aside>
  );
}

export default CatalogNotice;
