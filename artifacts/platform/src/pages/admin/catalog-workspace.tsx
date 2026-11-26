import type { ReactNode } from "react";
import { Link } from "wouter";

const views = [
  { id: "catalog", href: "/admin/edit-catalog", label: "Edit Catalog", roles: ["global_admin", "admin"] },
  { id: "variants", href: "/admin/catalogue-products", label: "Products & Variants", roles: ["global_admin", "admin", "supervisor"] },
  { id: "inventory", href: "/admin/inventory", label: "Inventory", roles: null },
] as const;

export function CatalogWorkspace({ active, role, children }: {
  active: typeof views[number]["id"];
  role: string;
  children: ReactNode;
}) {
  const available = views.filter(view => view.id === active || !view.roles || view.roles.some(allowed => allowed === role));
  return (
    <div className="mx-auto w-full max-w-screen-2xl">
      {available.length > 1 && (
        <nav aria-label="Catalog workspace" className="flex flex-wrap gap-1 border-b border-border px-3 pt-3 sm:px-6">
          {available.map(view => (
            <Link key={view.id} href={view.href} aria-current={active === view.id ? "page" : undefined}
              className="rounded-t-md border-b-2 border-transparent px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted aria-[current=page]:border-primary aria-[current=page]:text-foreground">
              {view.label}
            </Link>
          ))}
        </nav>
      )}
      {children}
    </div>
  );
}
