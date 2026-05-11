import { useBrand } from "@/contexts/BrandContext";
import { getCatalogNotice } from "@/lib/constants/catalogNotices";

interface CatalogNoticeProps {
  className?: string;
}

export function CatalogNotice({ className = "" }: CatalogNoticeProps) {
  const { brand } = useBrand();
  const notice = getCatalogNotice(brand);

  return (
    <aside
      role="note"
      aria-label="Merchant disclaimer"
      data-testid="catalog-notice"
      className={`w-full rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 text-xs italic text-muted-foreground leading-relaxed ${className}`}
    >
      {notice}
    </aside>
  );
}

export default CatalogNotice;
