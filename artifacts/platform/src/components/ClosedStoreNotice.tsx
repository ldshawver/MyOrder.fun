import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";

export type ClosedStoreLocation = {
  locationId?: number;
  locationName?: string;
  configured: boolean;
  immediateAvailable: boolean;
  message: string;
  nextOpenAt: string | null;
  slots: Array<{ at: string; label: string }>;
  regularHours?: Array<{ day: string; hours: string }>;
};

function nextOpening(location: ClosedStoreLocation): string | null {
  return location.slots.find(slot => slot.at === location.nextOpenAt)?.label ?? location.slots[0]?.label ?? null;
}

export function ClosedStoreNotice({ location }: { location: ClosedStoreLocation | null }) {
  if (!location || location.immediateAvailable) return null;
  const opens = location.configured ? nextOpening(location) : null;
  return (
    <div role="status" data-testid="closed-store-notice" className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-background/75 px-4 py-3 shadow-sm backdrop-blur-md sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium tracking-tight">
          {location.configured ? "Closed" : "Hours not published"}
          {opens && <time className="ml-2 font-mono text-xs font-medium text-muted-foreground">{opens}</time>}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {opens ? "You can still order. Choose a pickup time at checkout." : "No pickup times are open in this schedule."}
        </p>
      </div>
      <a
        href="/catalog#catalogue"
        onClick={event => {
          const catalogue = document.getElementById("catalogue");
          if (!catalogue) return;
          event.preventDefault();
          catalogue.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-sm"
        data-testid="closed-store-catalogue"
      >
        Browse the catalogue
      </a>
    </div>
  );
}

export function CatalogClosedStoreNotice() {
  const { getToken } = useAuth();
  const [locations, setLocations] = useState<ClosedStoreLocation[]>([]);
  useEffect(() => {
    let cancelled = false;
    getToken()
      .then(token => fetch("/api/orders/pickup-availability", { headers: token ? { Authorization: `Bearer ${token}` } : {} }))
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return [];
        return Array.isArray(data.locations) ? data.locations as ClosedStoreLocation[] : [];
      })
      .then(rows => { if (!cancelled) setLocations(rows); })
      .catch(() => { if (!cancelled) setLocations([]); });
    return () => { cancelled = true; };
  }, [getToken]);
  if (!locations.length || locations.some(location => location.immediateAvailable)) return null;
  const closed = locations
    .filter(location => !location.immediateAvailable)
    .sort((a, b) => (a.nextOpenAt ?? "9999").localeCompare(b.nextOpenAt ?? "9999"));
  return (
    <div data-testid="catalog-closed-store-notice">
      <ClosedStoreNotice location={closed[0] ?? null} />
    </div>
  );
}
