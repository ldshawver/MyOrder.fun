import { type ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import "./holiday-decorations.css";

const motifs = {
  christmas: ["🎄", "🎁", "✦"],
  halloween: ["🕸", "🎃", "🕷"],
  easter: ["🥚", "🐇", "🌱"],
  valentines: ["♥", "♡", "♥"],
  independence: ["★", "✦", "★"],
  memorial: ["★", "✦", "★"],
  thanksgiving: ["🍁", "🎃", "🍂"],
  newyear: ["✦", "★", "✧"],
  labor: ["★", "✦", "★"],
  juneteenth: ["✦", "★", "✦"],
} as const;

export type HolidayTheme = keyof typeof motifs;
export const holidayDisplayKey = ["holiday-decorations"] as const;
type Display = { theme: HolidayTheme | null; animated: boolean };

export function HolidayDecorationLayer({ theme, animated, preview = false }: Display & { preview?: boolean }) {
  if (!theme || !Object.hasOwn(motifs, theme)) return null;
  const [left, right, particle] = motifs[theme];
  const effects = animated && ["christmas", "independence", "newyear"].includes(theme);
  const particleCount = theme === "christmas" ? 14 : 8;
  return (
    <div aria-hidden="true" className="holiday-layer" data-theme={theme} data-preview={preview || undefined}>
      <span className="holiday-corner holiday-corner-left">{left}</span>
      <span className="holiday-corner holiday-corner-right">{right}</span>
      {effects && Array.from({ length: particleCount }, (_, index) => (
        <span key={index} className="holiday-particle">{theme === "christmas" ? "❄" : particle}</span>
      ))}
    </div>
  );
}

export function HolidayStorefront({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const { getToken, isLoaded, isSignedIn, userId, orgId } = useAuth();
  const shopping = /^\/(?:catalog(?:ue)?|cart|checkout|orders)(?:\/|$)/.test(path);
  const { data } = useQuery({
    queryKey: [...holidayDisplayKey, userId ?? null, orgId ?? null],
    enabled: shopping && isLoaded,
    staleTime: 5 * 60_000,
    refetchInterval: shopping ? 5 * 60_000 : false,
    retry: false,
    queryFn: async ({ signal }): Promise<Display> => {
      const token = isSignedIn ? await getToken() : null;
      if (isSignedIn && !token) throw new Error("Shopping session unavailable.");
      const response = await fetch(isSignedIn ? "/api/catalog/holiday-decorations" : "/api/public/holiday-decorations", {
        signal,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) throw new Error("Decorations unavailable.");
      return response.json();
    },
  });
  const theme = shopping && data?.theme && Object.hasOwn(motifs, data.theme) ? data.theme : null;
  return (
    <div className="holiday-storefront" data-holiday={theme ?? undefined}>
      {children}
      <HolidayDecorationLayer theme={theme} animated={data?.animated === true} />
    </div>
  );
}
