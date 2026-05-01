import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

export type Brand = "alavont" | "lucifer_cruz";

interface BrandContextValue {
  brand: Brand;
  setBrand: (b: Brand) => void;
}

const BrandContext = createContext<BrandContextValue>({
  brand: "alavont",
  setBrand: () => {},
});

const ALAVONT_VARS: Record<string, string> = {
  "--background": "220 40% 8%",
  "--foreground": "210 30% 96%",
  "--border": "220 30% 16%",
  "--input": "220 30% 14%",
  "--ring": "214 90% 55%",
  "--card": "220 38% 11%",
  "--card-foreground": "210 30% 96%",
  "--card-border": "220 30% 16%",
  "--popover": "220 40% 7%",
  "--popover-foreground": "210 30% 96%",
  "--popover-border": "220 30% 18%",
  "--primary": "214 90% 55%",
  "--primary-foreground": "220 40% 8%",
  "--secondary": "220 30% 16%",
  "--secondary-foreground": "210 30% 96%",
  "--muted": "220 30% 16%",
  "--muted-foreground": "215 20% 55%",
  "--accent": "214 80% 50%",
  "--accent-foreground": "220 40% 8%",
  "--destructive": "0 70% 45%",
  "--destructive-foreground": "210 30% 96%",
  "--sidebar": "220 42% 7%",
  "--sidebar-foreground": "210 30% 96%",
  "--sidebar-border": "220 30% 14%",
  "--sidebar-primary": "214 90% 55%",
  "--sidebar-primary-foreground": "220 40% 8%",
  "--sidebar-accent": "220 30% 14%",
  "--sidebar-accent-foreground": "210 30% 96%",
  "--sidebar-ring": "214 90% 55%",
};

const LUCIFER_VARS: Record<string, string> = {
  "--background": "0 30% 5%",
  "--foreground": "0 10% 95%",
  "--border": "0 25% 14%",
  "--input": "0 25% 12%",
  "--ring": "0 78% 48%",
  "--card": "0 28% 8%",
  "--card-foreground": "0 10% 95%",
  "--card-border": "0 25% 14%",
  "--popover": "0 30% 5%",
  "--popover-foreground": "0 10% 95%",
  "--popover-border": "0 25% 16%",
  "--primary": "0 78% 48%",
  "--primary-foreground": "0 10% 95%",
  "--secondary": "0 25% 14%",
  "--secondary-foreground": "0 10% 95%",
  "--muted": "0 25% 14%",
  "--muted-foreground": "0 15% 50%",
  "--accent": "0 72% 42%",
  "--accent-foreground": "0 10% 95%",
  "--destructive": "0 72% 40%",
  "--destructive-foreground": "0 10% 95%",
  "--sidebar": "0 30% 4%",
  "--sidebar-foreground": "0 10% 95%",
  "--sidebar-border": "0 25% 12%",
  "--sidebar-primary": "0 78% 48%",
  "--sidebar-primary-foreground": "0 10% 95%",
  "--sidebar-accent": "0 25% 12%",
  "--sidebar-accent-foreground": "0 10% 95%",
  "--sidebar-ring": "0 78% 48%",
};

function applyBrandVars(brand: Brand) {
  const vars = brand === "lucifer_cruz" ? LUCIFER_VARS : ALAVONT_VARS;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrandState] = useState<Brand>(() => {
    try {
      const saved = localStorage.getItem("orderflow_brand");
      return (saved === "lucifer_cruz" ? "lucifer_cruz" : "alavont") as Brand;
    } catch {
      return "alavont";
    }
  });

  useEffect(() => {
    applyBrandVars(brand);
  }, [brand]);

  function setBrand(b: Brand) {
    setBrandState(b);
    try { localStorage.setItem("orderflow_brand", b); } catch { }
  }

  return (
    <BrandContext.Provider value={{ brand, setBrand }}>
      {children}
    </BrandContext.Provider>
  );
}

export function useBrand() {
  return useContext(BrandContext);
}
