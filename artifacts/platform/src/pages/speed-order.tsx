import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { CheckCircle2, Minus, Plus, RefreshCw, Search, ShoppingBasket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Slot = { slot: number; source: "pin" | "rank" | "empty"; catalogItemId: number | null; units: number; name: string | null; price: number | null; imageUrl: string | null };
type Member = { id: number; name: string };
type PickupLocation = { locationId: number; locationName: string; configured: boolean; immediateAvailable: boolean; slots: Array<{ at: string; label: string }>; message: string };
type CheckoutQuote = { merchandiseSubtotal: number; customerTax: number; deliveryFee: number; tipAmount: number; finalAmountDue: number; tenderDue: number; checkoutTaxQuoteToken: string; pickup?: { locationId: number; pickupAt: string } | null };
type Conversion = { conversionToken: string; checkoutConversionToken?: string; confirmation: { acceptedAllSalesFinal: true; confirmedAt: string; legalDisclaimerText: string }; converted: { items: Array<{ catalogItemId: number; displayName: string; quantity: number; unitPrice: number; lineSubtotal: number }> } };

const FINAL_SALE_TEXT = "All sales are final. I confirm the member reviewed the item list, quantities, server pricing, and pickup instructions before cash payment.";

function errorMessage(value: unknown, fallback: string) {
  if (value && typeof value === "object") {
    const body = value as { error?: unknown; message?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error.replaceAll("_", " ");
  }
  return fallback;
}

export default function SpeedOrder() {
  const { getToken } = useAuth();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [memberQuery, setMemberQuery] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [pickupLocations, setPickupLocations] = useState<PickupLocation[]>([]);
  const [pickupLocationId, setPickupLocationId] = useState<number | null>(null);
  const [pickupAt, setPickupAt] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const [amountTendered, setAmountTendered] = useState("");
  const [busy, setBusy] = useState<"review" | "order" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ orderId: number; total: number; change: number } | null>(null);

  const authHeaders = useCallback(async (memberId?: number) => {
    const token = await getToken();
    return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(memberId ? { "X-Speed-Order-Member-Id": String(memberId) } : {}) };
  }, [getToken]);

  const request = useCallback(async <T,>(url: string, init: RequestInit = {}, memberId?: number): Promise<T> => {
    const response = await fetch(url, { ...init, headers: { ...(await authHeaders(memberId)), ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(errorMessage(data, `Request failed (${response.status})`));
    return data as T;
  }, [authHeaders]);

  const loadTopNine = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const data = await request<{ slots: Slot[] }>("/api/speed-order/top-nine");
      setSlots(Array.isArray(data.slots) ? data.slots : []);
    } catch (error) { setLoadError(error instanceof Error ? error.message : "Could not load Speed Order."); }
    finally { setLoading(false); }
  }, [request]);

  useEffect(() => { void loadTopNine(); }, [loadTopNine]);
  useEffect(() => {
    const timer = window.setTimeout(async () => {
      setMembersLoading(true);
      try { setMembers((await request<{ members: Member[] }>(`/api/speed-order/members?q=${encodeURIComponent(memberQuery)}`)).members); }
      catch { setMembers([]); }
      finally { setMembersLoading(false); }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [memberQuery, request]);

  const lines = useMemo(() => Object.entries(quantities).flatMap(([id, quantity]) => quantity > 0 ? [{ catalogItemId: Number(id), quantity }] : []), [quantities]);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const invalidateReview = () => { setConversion(null); setQuote(null); setAmountTendered(""); setActionError(null); };
  const changeQuantity = (id: number, delta: number) => {
    invalidateReview(); setSuccess(null);
    setQuantities(current => ({ ...current, [id]: Math.max(0, Math.min(99, (current[id] ?? 0) + delta)) }));
  };

  const memberId = selectedMember?.id;
  useEffect(() => {
    const controller = new AbortController();
    setConversion(null); setQuote(null); setAmountTendered(""); setActionError(null);
    setPickupLocations([]); setPickupLocationId(null); setPickupAt("");
    if (memberId) {
      void request<{ locations: PickupLocation[] }>("/api/orders/pickup-availability", {
        signal: controller.signal, cache: "no-store",
      }, memberId).then(({ locations }) => {
        if (controller.signal.aborted) return;
        const available = locations.filter(location => location.configured);
        const first = available.find(location => location.immediateAvailable || location.slots.length > 0);
        setPickupLocations(available);
        setPickupLocationId(first?.locationId ?? null);
        setPickupAt(first?.immediateAvailable ? "immediate" : "");
        if (!first) setActionError("Pickup is currently unavailable.");
      }).catch(error => {
        if (!controller.signal.aborted) setActionError(error instanceof Error ? error.message : "Pickup availability could not be loaded.");
      });
    }
    return () => controller.abort();
  }, [memberId, request]);

  const selectedPickup = pickupLocations.find(location => location.locationId === pickupLocationId);
  const pickupSelected = !!selectedPickup && (pickupAt === "immediate"
    ? selectedPickup.immediateAvailable
    : selectedPickup.slots.some(slot => slot.at === pickupAt));

  async function reviewOrder() {
    if (!selectedMember || !lines.length || !accepted || !selectedPickup || !pickupSelected) return;
    setBusy("review"); setActionError(null);
    try {
      const confirmation = { acceptedAllSalesFinal: true as const, confirmedAt: new Date().toISOString(), legalDisclaimerText: FINAL_SALE_TEXT };
      const converted = await request<Conversion>("/api/cart/convert", { method: "POST", body: JSON.stringify({ items: lines, confirmation }) }, selectedMember.id);
      const selection = pickupAt === "immediate" ? undefined : pickupAt;
      const priced = await request<CheckoutQuote>("/api/checkout/quote", {
        method: "POST", body: JSON.stringify({ items: lines, paymentMethod: "cash", deliveryMethod: "pickup",
          pickupLocationId: selectedPickup.locationId, ...(selection ? { pickupAt: selection } : {}) }),
      }, selectedMember.id);
      setConversion(converted); setQuote(priced); setAmountTendered(priced.tenderDue.toFixed(2));
    } catch (error) { setActionError(error instanceof Error ? error.message : "Could not prepare this order."); }
    finally { setBusy(null); }
  }

  async function placeOrder() {
    if (!selectedMember || !conversion || !quote || !pickupLocationId) return;
    const tendered = Number(amountTendered);
    if (!Number.isFinite(tendered) || tendered < quote.tenderDue) { setActionError("Cash tendered must cover the server total."); return; }
    setBusy("order"); setActionError(null);
    try {
      const pickup = pickupAt && pickupAt !== "immediate" ? pickupAt : undefined;
      const order = await request<{ id: number }>("/api/orders", { method: "POST", body: JSON.stringify({
        items: lines, selectedPaymentMethod: "cash", paymentMethod: "cash", pickupLocationId, ...(pickup ? { pickupAt: pickup } : {}),
        checkoutConversionToken: conversion.checkoutConversionToken ?? conversion.conversionToken,
        checkoutConversionSnapshot: Object.fromEntries(Object.entries(conversion).filter(([key]) => !["conversionToken", "checkoutConversionToken"].includes(key))),
        checkoutConfirmation: { ...conversion.confirmation, paymentMethod: "cash", checkoutTaxQuoteToken: quote.checkoutTaxQuoteToken, customerCreditAmount: 0, tipAmount: 0 },
      }) }, selectedMember.id);
      const closed = await request<{ cash?: { changeGiven?: string | number } }>(`/api/orders/${order.id}/closeout`, { method: "POST", body: JSON.stringify({ paymentMethod: "cash", amountTendered: tendered.toFixed(2), idempotencyKey: `speed-order-${order.id}-${crypto.randomUUID()}`, supervisorOverride: false }) });
      setSuccess({ orderId: order.id, total: quote.tenderDue, change: Number(closed.cash?.changeGiven ?? tendered - quote.tenderDue) });
      setQuantities({}); setConversion(null); setQuote(null); setAccepted(false); setAmountTendered("");
    } catch (error) { setActionError(error instanceof Error ? error.message : "Order could not be completed."); }
    finally { setBusy(null); }
  }

  if (success) return <section className="mx-auto max-w-lg py-8" data-testid="speed-order-success"><div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-6 text-center"><CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400" /><h1 className="mt-3 text-2xl font-bold">Order complete</h1><p className="mt-2">Order #{success.orderId} · ${success.total.toFixed(2)}</p><p className="text-sm text-muted-foreground">Change due: ${success.change.toFixed(2)}</p><Button className="mt-5 w-full min-h-12" onClick={() => setSuccess(null)}>Start another Speed Order</Button></div></section>;

  return <section className="mx-auto max-w-4xl space-y-5" data-testid="speed-order-screen">
    <div><h1 className="text-2xl font-bold">Speed Order</h1><p className="mt-1 text-sm text-muted-foreground">Tenant top sellers · member pickup · accountable cash checkout</p></div>
    <div className="rounded-xl border bg-card p-4"><label className="text-sm font-semibold" htmlFor="member-search">1. Select member</label><div className="relative mt-2"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input id="member-search" className="h-11 pl-9" value={memberQuery} onChange={event => { setMemberQuery(event.target.value); setSelectedMember(null); }} placeholder="Search name or email" /></div>{selectedMember ? <div className="mt-2 rounded-lg bg-primary/10 p-3 font-medium">{selectedMember.name}</div> : <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border">{membersLoading ? <p className="p-3 text-sm text-muted-foreground">Loading members…</p> : members.length ? members.map(member => <button type="button" key={member.id} onClick={() => { setSelectedMember(member); setMemberQuery(member.name); }} className="block min-h-11 w-full border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-muted">{member.name}</button>) : <p className="p-3 text-sm text-muted-foreground">No eligible members found.</p>}</div>}</div>
    <div className="rounded-xl border bg-card p-4"><div className="mb-3 flex items-center justify-between"><div><h2 className="font-semibold">2. Tap top items</h2><p className="text-xs text-muted-foreground">Prices shown are server supplied; final totals are recalculated at checkout.</p></div><Button size="sm" variant="ghost" onClick={() => void loadTopNine()} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></Button></div>{loading ? <div className="grid grid-cols-3 gap-2">{Array.from({ length: 9 }, (_, index) => <div key={index} className="aspect-square animate-pulse rounded-xl bg-muted" />)}</div> : loadError ? <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm"><p>{loadError}</p><Button className="mt-3" variant="outline" onClick={() => void loadTopNine()}>Retry</Button></div> : slots.every(slot => !slot.catalogItemId) ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No eligible top items are available yet.</p> : <div className="grid grid-cols-3 gap-2">{slots.map(slot => slot.catalogItemId ? <div key={slot.slot} className="flex min-h-36 flex-col rounded-xl border bg-background p-2"><button type="button" className="flex flex-1 flex-col text-left" onClick={() => changeQuantity(slot.catalogItemId!, 1)}><div className="line-clamp-2 text-xs font-semibold">{slot.name}</div><div className="mt-auto text-sm font-bold">${slot.price?.toFixed(2)}</div></button><div className="mt-2 flex items-center justify-between rounded-lg bg-muted"><button aria-label={`Remove ${slot.name}`} className="min-h-10 px-2" onClick={() => changeQuantity(slot.catalogItemId!, -1)}><Minus className="h-4 w-4" /></button><span className="font-bold">{quantities[slot.catalogItemId] ?? 0}</span><button aria-label={`Add ${slot.name}`} className="min-h-10 px-2" onClick={() => changeQuantity(slot.catalogItemId!, 1)}><Plus className="h-4 w-4" /></button></div></div> : <div key={slot.slot} className="min-h-36 rounded-xl border border-dashed bg-muted/20" aria-label="Empty Speed Order slot" />)}</div>}</div>
    {selectedMember && pickupLocations.length > 0 && (
      <fieldset disabled={busy !== null} className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2">
        <label className="text-xs font-medium">Pickup location
          <select className="mt-1 block w-full rounded-md border bg-background p-2" value={pickupLocationId ?? ""}
            onChange={event => {
              const selected = pickupLocations.find(location => location.locationId === Number(event.target.value));
              invalidateReview();
              setPickupLocationId(selected?.locationId ?? null);
              setPickupAt(selected?.immediateAvailable ? "immediate" : "");
            }}>
            <option value="">Choose a pickup location</option>
            {pickupLocations.map(location => <option key={location.locationId} value={location.locationId}>{location.locationName}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium">Pickup time
          <select className="mt-1 block w-full rounded-md border bg-background p-2" value={pickupAt}
            onChange={event => { invalidateReview(); setPickupAt(event.target.value); }}>
            <option value="">Choose a pickup time</option>
            {selectedPickup?.immediateAvailable && <option value="immediate">Immediate pickup</option>}
            {selectedPickup?.slots.map(slot => <option key={slot.at} value={slot.at}>{slot.label}</option>)}
          </select>
        </label>
      </fieldset>
    )}
    <div className="sticky bottom-20 z-20 rounded-xl border bg-card p-4 shadow-xl md:bottom-4"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><ShoppingBasket className="h-5 w-5" /><span className="font-semibold">{itemCount} item{itemCount === 1 ? "" : "s"}</span></div>{quote && <span className="text-xl font-bold">${quote.tenderDue.toFixed(2)}</span>}</div>{quote && <div className="mt-3 space-y-1 rounded-lg bg-muted p-3 text-sm"><div className="flex justify-between"><span>Merchandise</span><span>${quote.merchandiseSubtotal.toFixed(2)}</span></div><div className="flex justify-between"><span>Tax</span><span>${quote.customerTax.toFixed(2)}</span></div><div className="flex justify-between font-bold"><span>Server total</span><span>${quote.finalAmountDue.toFixed(2)}</span></div><label className="mt-3 block font-medium" htmlFor="cash-tendered">Cash tendered</label><Input id="cash-tendered" inputMode="decimal" value={amountTendered} onChange={event => setAmountTendered(event.target.value)} /></div>}<label className="mt-3 flex items-start gap-2 text-xs"><input type="checkbox" className="mt-1 h-4 w-4" checked={accepted} onChange={event => { setAccepted(event.target.checked); invalidateReview(); }} /><span>{FINAL_SALE_TEXT}</span></label>{actionError && <div role="alert" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">{actionError}</div>}{quote && pickupLocations.length > 0 && <div className="mt-3 text-xs text-muted-foreground">Pickup: {pickupLocations.find(location => location.locationId === pickupLocationId)?.locationName} · {pickupAt === "immediate" ? "as soon as available" : pickupLocations.flatMap(location => location.slots).find(slot => slot.at === pickupAt)?.label}</div>}<Button className="mt-3 min-h-12 w-full text-base" disabled={!selectedMember || !lines.length || !accepted || !pickupSelected || busy !== null} onClick={() => void (quote ? placeOrder() : reviewOrder())}>{busy ? "Working…" : quote ? "Accept cash & place order" : "Review server total"}</Button></div>
  </section>;
}
