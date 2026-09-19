import { createContext, useCallback, useContext, useState, useEffect, type ReactNode } from "react";
import { resolveBranding, type BrandingInput, type ResolvedBranding } from "@/lib/branding";

export type Brand = "alavont" | "lucifer_cruz";

interface BrandContextValue {
  brand: Brand;
  branding: ResolvedBranding;
  setBranding: (branding: BrandingInput | null) => void;
  publicBrandLoading: boolean;
}

const BrandContext = createContext<BrandContextValue>({
  brand: "alavont",
  branding: resolveBranding(),
  setBranding: () => {},
  publicBrandLoading: true,
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

function hexToHsl(value: string): string | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), light = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  if (delta) hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  const saturation = delta ? delta / (1 - Math.abs(2 * light - 1)) : 0;
  return `${Math.round((hue * 60 + 360) % 360)} ${Math.round(saturation * 100)}% ${Math.round(light * 100)}%`;
}

function applyBrandVars(branding: ResolvedBranding) {
  const vars = ALAVONT_VARS;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
  const primary = hexToHsl(branding.customer.primaryColor);
  const secondary = hexToHsl(branding.customer.secondaryColor);
  if (primary) root.style.setProperty("--primary", primary);
  if (secondary) root.style.setProperty("--secondary", secondary);
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const [branding, setResolvedBranding] = useState<ResolvedBranding>(() => resolveBranding());
  const [brand] = useState<Brand>("alavont");
  const [publicBrandLoading, setPublicBrandLoading] = useState(true);

  useEffect(() => {
    applyBrandVars(branding);
  }, [branding]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/public/branding", { credentials: "same-origin" })
      .then((response) => response.ok ? response.json() : null)
      .then((value: BrandingInput | null) => {
        if (!cancelled && value) setResolvedBranding(resolveBranding(value));
      })
      .catch(() => { /* unknown hosts intentionally retain the generic platform presentation */ })
      .finally(() => { if (!cancelled) setPublicBrandLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    document.title = branding.customer.displayName;
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon) favicon.href = branding.customer.faviconUrl;
  }, [branding]);

  const setBranding = useCallback((value: BrandingInput | null) => {
    setResolvedBranding(resolveBranding(value));
  }, []);

  return (
    <BrandContext.Provider value={{ brand, branding, setBranding, publicBrandLoading }}>
      {children}
    </BrandContext.Provider>
  );
}

export function useBrand() {
  return useContext(BrandContext);
}
