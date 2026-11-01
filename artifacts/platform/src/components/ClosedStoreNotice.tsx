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

export function ClosedStoreNotice({ location }: { location: ClosedStoreLocation | null }) {
  if (!location) return null;
  if (!location.configured) {
    return (
      <div role="alert" data-testid="closed-store-notice" className="rounded-sm border border-amber-500/50 bg-amber-500/15 p-4 text-sm text-foreground">
        <p className="font-semibold">Pickup hours are not published for this store.</p>
        <p className="mt-1">A pickup order cannot be placed until the store sets its open hours.</p>
      </div>
    );
  }
  if (location.immediateAvailable) return null;
  const nextLabel = location.slots.find(slot => slot.at === location.nextOpenAt)?.label ?? location.slots[0]?.label ?? null;
  const openDays = (location.regularHours ?? []).filter(row => row.hours !== "Closed");
  return (
    <div role="alert" data-testid="closed-store-notice" className="rounded-sm border border-amber-500/50 bg-amber-500/15 p-4 text-sm text-foreground">
      <p className="font-semibold">The store is closed. This order has to wait for pickup during business hours.</p>
      <p className="mt-1">{location.message}</p>
      <p className="mt-1">Choose an open pickup time to finish placing the order. If you do not want a later pickup, you cannot place the order.</p>
      {nextLabel && <p className="mt-2 font-medium">Next opening: {nextLabel}</p>}
      {location.locationName && <p className="mt-1 text-xs text-muted-foreground">{location.locationName}</p>}
      {openDays.length > 0 && (
        <ul className="mt-2 grid gap-0.5 text-xs sm:grid-cols-2">
          {openDays.map(row => <li key={row.day}>{row.day}: {row.hours}</li>)}
        </ul>
      )}
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
  const closed = locations.filter(location => !location.immediateAvailable);
  if (!closed.length) return null;
  return (
    <div className="space-y-3" data-testid="catalog-closed-store-notice">
      {closed.map(location => <ClosedStoreNotice key={location.locationId ?? location.locationName} location={location} />)}
    </div>
  );
}
