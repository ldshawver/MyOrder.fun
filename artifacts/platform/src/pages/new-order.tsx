import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@clerk/react";
import { useCreateOrder, useListCatalogItems, useGetCatalogItem, useAiUpsellSuggestions, useGetCurrentUser, useTokenizePayment, useConfirmPayment, type CatalogItem } from "@workspace/api-client-react";
import { useCart } from "@/contexts/CartContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Search, Plus, Minus, Trash, Sparkles, ShieldCheck, Wand2, Banknote, CreditCard, Gift, CheckCircle2, Truck, RefreshCw, ReceiptText, ShoppingCart, MapPin, PackageCheck, HandCoins } from "lucide-react";
import { normalizeNotificationRole, usePushNotifications } from "@/hooks/usePushNotifications";
import { useBrand } from "@/contexts/BrandContext";
import { CatalogNotice } from "@/components/CatalogNotice";

type PromotedItem = { id: number; name: string; category: string; price: number; imageUrl: string | null; isAvailable: boolean };
type DeliveryMethod = "pickup" | "manual_delivery" | "uber_direct" | "csr_delivery";
type CsrDeliveryStatus = {
  hasActiveShift: boolean;
  csrDeliveryAvailable: boolean;
  shiftId?: number;
  pickupNote?: string | null;
};
type DeliveryQuote = {
  provider: "uber_direct";
  quoteId: string;
  fee: number | null;
  feeCents: number | null;
  currency: string;
  dropoffEta: string | null;
  duration: number | null;
  pickupDuration: number | null;
  expires: string | null;
  pickupAction: "default" | "pick_pack_pay";
  manifestItems?: Array<{ name: string; quantity: number; price?: number }>;
};
type ConversionPreview = {
  confirmation: {
    acceptedAllSalesFinal: true;
    confirmedAt: string;
    legalDisclaimerText: string;
  };
  pricingSnapshot: {
    subtotal: number;
    tax: number;
    total: number;
    taxRate: number;
  };
  converted: {
    brandName: string;
    headline: string;
    zappyMessage: string;
    paymentMethods: Array<{ id: string; label: string; promoted?: boolean; message?: string }>;
    items: Array<{
      catalogItemId: number;
      displayName: string;
      displayDescription: string;
      displayCategory: string;
      displayImage: string | null;
      merchantBrandName: string;
      marketingCopy: string;
      upsellCopy: string | null;
      promoBadges: string[];
      quantity: number;
      unitPrice: number;
      lineSubtotal: number;
    }>;
  };
};

const FINAL_SALE_TEXT = "All sales are final. I confirm the item list, quantities, pricing, fees, and fulfillment instructions before payment.";
const CONVERSION_NOTE = "Items in this cart will be converted to the appropriate customer-facing items before purchase.";

export default function NewOrder() {
  const [, setLocation] = useLocation();
  const { brand } = useBrand();
  const { cart, addItem, removeItem, updateQuantity, replaceCart, clearCart } = useCart();
  const preItemId = parseInt(new URLSearchParams(window.location.search).get("item") || "0", 10) || undefined;
  const [search, setSearch] = useState("");
  const [shippingAddress, setShippingAddress] = useState("");
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>("pickup");
  const [deliveryQuote, setDeliveryQuote] = useState<DeliveryQuote | null>(null);
  const [deliveryQuoteError, setDeliveryQuoteError] = useState<string | null>(null);
  const [isQuotingDelivery, setIsQuotingDelivery] = useState(false);
  const [notes, setNotes] = useState("");
  const [acceptedFinalSale, setAcceptedFinalSale] = useState(false);
  const [conversionPreview, setConversionPreview] = useState<ConversionPreview | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState("cash");
  const [promotedItems, setPromotedItems] = useState<PromotedItem[]>([]);
  const [reviewedLastItemPrompt, setReviewedLastItemPrompt] = useState(false);
  const [tipMode, setTipMode] = useState<"none" | "10" | "15" | "20" | "custom">("none");
  const [customTip, setCustomTip] = useState("");
  const [csrStatus, setCsrStatus] = useState<CsrDeliveryStatus | null>(null);
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [zappyOpen, setZappyOpen] = useState(true);
  const prevCartRef = useRef("");
  const upsellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preloaded = useRef(false);
  const { getToken } = useAuth();

  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const { notifyOrderPlaced } = usePushNotifications({
    role: normalizeNotificationRole(user?.role),
  });

  const { data: preItem } = useGetCatalogItem(preItemId!, {
    query: { enabled: !!preItemId, queryKey: ["getCatalogItem", preItemId] },
  });

  useEffect(() => {
    if (preItem && !preloaded.current) {
      preloaded.current = true;
      replaceCart([{ id: preItem.id, name: preItem.name, price: preItem.price, quantity: 1 }]);
    }
  }, [preItem, replaceCart]);

  const catalogMode = brand === "lucifer_cruz" ? "lucifer" : "alavont";
  const { data: catalog } = useListCatalogItems(
    { search, limit: 100, available: true, mode: catalogMode },
    { query: { queryKey: ["listCatalogItems", search, true, catalogMode] } }
  );

  const createOrderMutation = useCreateOrder();
  const tokenizeMutation = useTokenizePayment();
  const confirmMutation = useConfirmPayment();
  const upsellMutation = useAiUpsellSuggestions();
  const upsellMutateRef = useRef(upsellMutation.mutate);
  upsellMutateRef.current = upsellMutation.mutate;
  const upsellResetRef = useRef(upsellMutation.reset);
  upsellResetRef.current = upsellMutation.reset;

  useEffect(() => {
    setConversionPreview(null);
    setConversionError(null);
  }, [cart, shippingAddress, notes]);

  useEffect(() => {
    setDeliveryQuote(null);
    setDeliveryQuoteError(null);
  }, [cart, shippingAddress, deliveryMethod]);

  useEffect(() => {
    getToken()
      .then(token => fetch("/api/concierge/promoted", { headers: token ? { Authorization: `Bearer ${token}` } : {} }))
      .then(res => res.ok ? res.json() : [])
      .then((items: PromotedItem[]) => setPromotedItems(Array.isArray(items) ? items.filter(item => item.isAvailable) : []))
      .catch(() => setPromotedItems([]));
  }, [getToken]);

  // Fetch active CSR delivery status — drives whether "CSR Delivery" option is shown
  useEffect(() => {
    getToken()
      .then(token => fetch("/api/shifts/active-csr-status", { headers: token ? { Authorization: `Bearer ${token}` } : {} }))
      .then(res => res.ok ? res.json() : null)
      .then((data: CsrDeliveryStatus | null) => setCsrStatus(data))
      .catch(() => setCsrStatus(null));
  }, [getToken]);

  useEffect(() => {
    const cartKey = cart.map(c => `${c.id}:${c.quantity}`).sort().join(",");
    if (cartKey === prevCartRef.current) return;
    prevCartRef.current = cartKey;
    if (upsellTimerRef.current) clearTimeout(upsellTimerRef.current);
    if (cart.length === 0) { upsellResetRef.current(); return; }
    upsellTimerRef.current = setTimeout(() => {
      upsellMutateRef.current({ data: { cartItemIds: cart.map(c => c.id) } });
    }, 500);
    return () => {
      if (upsellTimerRef.current) clearTimeout(upsellTimerRef.current);
    };
  }, [cart]);

  const addToCart = (item: CatalogItem) => addItem(item);

  const addPromotedToCart = (item: PromotedItem) => {
    addItem(item);
    setReviewedLastItemPrompt(true);
  };

  const handlePreviewConversion = async () => {
    if (cart.length === 0 || !acceptedFinalSale) return;
    setIsConverting(true);
    setConversionError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/orders/preview-conversion", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          items: cart.map(i => ({ catalogItemId: i.id, quantity: i.quantity })),
          confirmation: {
            acceptedAllSalesFinal: true,
            confirmedAt: new Date().toISOString(),
            legalDisclaimerText: FINAL_SALE_TEXT,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? "Product conversion failed.");
      }
      setConversionPreview(data as ConversionPreview);
      setSelectedPaymentMethod((data as ConversionPreview).converted.paymentMethods[0]?.id ?? "cash");
    } catch (e) {
      setConversionError(e instanceof Error ? e.message : "Product conversion failed.");
    } finally {
      setIsConverting(false);
    }
  };

  const handleDeliveryQuote = async () => {
    if (cart.length === 0 || !shippingAddress.trim()) return;
    setIsQuotingDelivery(true);
    setDeliveryQuoteError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/orders/delivery-quote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          items: cart.map(i => ({ catalogItemId: i.id, quantity: i.quantity })),
          dropoffAddress: shippingAddress,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? "Uber Courier quote failed.");
      }
      setDeliveryQuote(data as DeliveryQuote);
    } catch (e) {
      setDeliveryQuoteError(e instanceof Error ? e.message : "Uber Courier quote failed.");
    } finally {
      setIsQuotingDelivery(false);
    }
  };

  const handleSubmit = async () => {
    if (cart.length === 0 || !conversionPreview) return;
    if (deliveryMethod === "uber_direct" && !deliveryQuote) return;
    if (requiresDeliveryAddress && !shippingAddress.trim()) return;

    // Save SMS opt-in preference (fire-and-forget)
    if (smsOptIn) {
      getToken().then(token => fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ smsOptIn: true }),
      })).catch(() => {});
    }

    try {
      const order = await createOrderMutation.mutateAsync({
        data: {
          items: cart.map(i => ({ catalogItemId: i.id, quantity: i.quantity })),
          shippingAddress: requiresDeliveryAddress ? shippingAddress : "",
          notes,
          deliveryMethod: deliveryMethod !== "pickup" ? deliveryMethod : undefined,
          deliveryQuote: deliveryMethod === "uber_direct" && deliveryQuote ? deliveryQuote : undefined,
          checkoutConfirmation: {
            acceptedAllSalesFinal: true,
            confirmedAt: conversionPreview.confirmation.confirmedAt,
            legalDisclaimerText: conversionPreview.confirmation.legalDisclaimerText,
            paymentMethod: selectedPaymentMethod as "cash" | "cash_app" | "stripe" | "venmo" | "gift_card" | "manual",
            tipAmount,
            tipPercent: tipMode === "custom" || tipMode === "none" ? undefined : Number(tipMode),
          },
        }
      });

      if (selectedPaymentMethod === "stripe") {
        const tokenized = await tokenizeMutation.mutateAsync({ data: { orderId: order.id, amount: order.total } });
        await confirmMutation.mutateAsync({ orderId: order.id, data: { paymentIntentId: tokenized.paymentIntentId } });
      }

      notifyOrderPlaced(order.id, user?.firstName || undefined);
      clearCart();
      try {
        const existing = JSON.parse(sessionStorage.getItem("alavont_session_orders") || "[]");
        sessionStorage.setItem("alavont_session_orders", JSON.stringify([...existing, order.id]));
      } catch { /* ignore storage errors */ }
      setLocation(`/orders/${order.id}`);
    } catch {
      // Mutation hooks expose their own error state/toasts through the API client.
    }
  };

  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const csrDeliveryFee = deliveryMethod === "csr_delivery" ? Math.round((5 + 0.03 * subtotal) * 100) / 100 : 0;
  const deliveryFee = deliveryMethod === "uber_direct" && deliveryQuote?.fee != null
    ? deliveryQuote.fee
    : deliveryMethod === "csr_delivery"
      ? csrDeliveryFee
      : 0;
  const tipBase = conversionPreview?.pricingSnapshot.subtotal ?? subtotal;
  const customTipAmount = Math.max(0, Number.parseFloat(customTip) || 0);
  const tipAmount = tipMode === "none"
    ? 0
    : tipMode === "custom"
      ? Math.round(customTipAmount * 100) / 100
      : Math.round(tipBase * (Number(tipMode) / 100) * 100) / 100;
  const displayedTotal = (conversionPreview?.pricingSnapshot.total ?? subtotal) + deliveryFee + tipAmount;
  const requiresDeliveryAddress = deliveryMethod === "manual_delivery" || deliveryMethod === "uber_direct";
  const lastItemPromptRequired = promotedItems.length > 0 && cart.length > 0 && !reviewedLastItemPrompt;
  const deliveryReady = deliveryMethod === "pickup"
    || deliveryMethod === "csr_delivery"
    || (deliveryMethod === "manual_delivery" && shippingAddress.trim().length > 0)
    || (deliveryMethod === "uber_direct" && !!deliveryQuote);
  const paymentBusy = createOrderMutation.isPending || tokenizeMutation.isPending || confirmMutation.isPending;
  const canSubmit = cart.length > 0 && !!conversionPreview && deliveryReady && !paymentBusy;

  return (
    <div className="space-y-6 max-w-7xl mx-auto min-h-[calc(100vh-8rem)] flex flex-col">
      <div className="flex items-center gap-4 shrink-0 pb-4 border-b border-border/50">
        <Link href="/orders" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-back">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-title">Cart & Checkout</h1>
          <p className="text-muted-foreground">Review the cart, choose pickup or delivery, convert with Zappy, then collect payment.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-[minmax(320px,1fr)_minmax(360px,0.95fr)_minmax(300px,0.85fr)] gap-6 items-start">
        {/* Receipt Cart */}
        <Card className="overflow-hidden rounded-sm border-border/50 shadow-sm bg-card">
          <CardHeader className="pb-3 bg-muted/10 border-b border-border/50">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2">
              <ReceiptText size={16} /> Receipt Cart
            </CardTitle>
            <div className="relative mt-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
              <Input
                placeholder="Search and add another item..."
                className="pl-10 rounded-sm bg-background border-border"
                value={search}
                onChange={e => setSearch(e.target.value)}
                data-testid="input-search"
              />
            </div>
            {search.trim() && (
              <div className="mt-2 max-h-56 overflow-y-auto rounded-sm border border-border/50 bg-background">
                {catalog?.items?.map(item => (
                  <button
                    type="button"
                    key={item.id}
                    className="flex w-full items-center justify-between gap-3 p-3 text-left border-b border-border/20 last:border-0 hover:bg-muted/50 transition-colors"
                    onClick={() => addToCart(item)}
                    data-testid={`catalog-item-${item.id}`}
                  >
                    <span className="min-w-0">
                      <span className="block font-medium text-sm truncate">{item.name}</span>
                      <span className="block text-xs text-muted-foreground font-mono mt-0.5">${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    </span>
                    <Plus size={14} className="text-primary shrink-0" />
                  </button>
                ))}
                {catalog?.items?.length === 0 && (
                  <div className="text-center py-6 text-muted-foreground text-xs font-mono uppercase tracking-wider">
                    No products found.
                  </div>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent className="p-5">
            <div className="rounded-sm border border-border/70 bg-background text-foreground shadow-inner">
              <div className="border-b border-dashed border-border px-4 py-3 text-center">
                <div className="text-xs font-semibold uppercase tracking-[0.24em]">Order Receipt</div>
                <div className="text-[10px] text-muted-foreground mt-1 font-mono">{new Date().toLocaleString()}</div>
              </div>
              <div className="min-h-[420px] p-4 space-y-3">
              {cart.length === 0 ? (
                <div className="h-72 flex flex-col items-center justify-center text-center text-muted-foreground text-sm font-mono uppercase tracking-wider border border-dashed border-border/50 rounded-sm">
                  <ShoppingCart size={24} className="mb-3" />
                  Cart is empty
                </div>
              ) : (
                cart.map(item => (
                  <div key={item.id} className="border-b border-dashed border-border/40 pb-3 last:border-0" data-testid={`cart-item-${item.id}`}>
                    <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm leading-tight pr-4">{item.name}</div>
                      <div className="text-xs text-muted-foreground font-mono mt-0.5">${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                    </div>
                      <div className="font-mono text-sm font-bold">${(item.price * item.quantity).toFixed(2)}</div>
                    </div>
                    <div className="flex items-center justify-between gap-4 mt-3">
                      <div className="flex items-center border border-border/50 rounded-sm bg-background">
                        <button className="h-9 w-9 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors" onClick={() => updateQuantity(item.id, -1)} data-testid={`button-decrease-${item.id}`}><Minus size={14}/></button>
                        <span className="w-8 text-center text-xs font-mono font-medium">{item.quantity}</span>
                        <button className="h-9 w-9 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors" onClick={() => updateQuantity(item.id, 1)} data-testid={`button-increase-${item.id}`}><Plus size={14}/></button>
                      </div>
                      <button className="text-muted-foreground hover:text-destructive transition-colors p-1" onClick={() => removeItem(item.id)} data-testid={`button-remove-${item.id}`}>
                        <Trash size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
              <div className="border-t border-dashed border-border p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-mono">${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                {conversionPreview && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Tax</span>
                    <span className="font-mono">${conversionPreview.pricingSnapshot.tax.toFixed(2)}</span>
                  </div>
                )}
                {deliveryFee > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      {deliveryMethod === "csr_delivery" ? "CSR Delivery Fee" : "Uber Courier"}
                    </span>
                    <span className="font-mono">${deliveryFee.toFixed(2)}</span>
                  </div>
                )}
                {tipAmount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Sales rep tip</span>
                    <span className="font-mono">${tipAmount.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-lg pt-2 border-t border-border/40">
                  <span>Total</span>
                  <span className="font-mono" data-testid="text-total">${displayedTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Checkout Steps */}
        <Card className="overflow-hidden rounded-sm border-border/50 shadow-sm">
          <CardHeader className="pb-3 bg-muted/10 border-b border-border/50">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Checkout Steps</CardTitle>
          </CardHeader>
          <CardContent className="p-5 space-y-5">
            <div className="rounded-sm border border-border/50 bg-background p-4 space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                <MapPin size={14} /> 1. Delivery or Pickup
              </div>
              <div className={`grid gap-2 ${csrStatus?.csrDeliveryAvailable ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
                    {[
                      { id: "pickup", label: "Pickup" },
                      { id: "manual_delivery", label: "Delivery" },
                      { id: "uber_direct", label: "Uber Courier" },
                      ...(csrStatus?.csrDeliveryAvailable ? [{ id: "csr_delivery", label: "CSR Delivery" }] : []),
                    ].map(option => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setDeliveryMethod(option.id as DeliveryMethod)}
                        className={`rounded-sm border px-2 py-2 text-xs font-semibold transition-colors ${deliveryMethod === option.id ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-muted/10 text-muted-foreground hover:border-primary/40"}`}
                        data-testid={`delivery-method-${option.id}`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>

                  {deliveryMethod === "csr_delivery" && (
                    <div className="rounded-sm border border-primary/30 bg-primary/5 p-3 text-xs space-y-1">
                      <div className="font-semibold text-primary">CSR Personal Delivery</div>
                      <div className="text-muted-foreground">Your order will be personally delivered by the on-shift rep.</div>
                      <div className="font-mono text-primary pt-1">Delivery fee: ${csrDeliveryFee.toFixed(2)} ($5 + 3% of subtotal)</div>
                      {csrStatus?.pickupNote && (
                        <div className="text-muted-foreground italic mt-1">{csrStatus.pickupNote}</div>
                      )}
                    </div>
                  )}

                  {requiresDeliveryAddress && (
                    <Input
                      placeholder="Delivery address"
                      value={shippingAddress}
                      onChange={e => setShippingAddress(e.target.value)}
                      className="rounded-sm bg-background"
                      data-testid="input-shipping"
                    />
                  )}
                  {deliveryMethod === "uber_direct" && (
                    <div className="space-y-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full rounded-sm h-9 text-xs font-semibold uppercase tracking-wider"
                        disabled={cart.length === 0 || !shippingAddress.trim() || isQuotingDelivery}
                        onClick={handleDeliveryQuote}
                        data-testid="button-uber-quote"
                      >
                        {isQuotingDelivery ? <RefreshCw size={14} className="mr-2 animate-spin" /> : <Truck size={14} className="mr-2" />}
                        {isQuotingDelivery ? "Quoting..." : "Quote Uber Courier"}
                      </Button>
                      {deliveryQuote && (
                        <div className="rounded-sm border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs" data-testid="uber-quote-summary">
                          <div className="font-semibold text-emerald-700">
                            Uber Courier quoted{deliveryQuote.fee != null ? ` at $${deliveryQuote.fee.toFixed(2)}` : ""}
                          </div>
                          <div className="text-muted-foreground mt-1">
                            {deliveryQuote.duration ? `${deliveryQuote.duration} min estimated delivery` : "Delivery ETA available after dispatch."}
                            {deliveryQuote.expires ? ` Quote expires ${new Date(deliveryQuote.expires).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : ""}
                          </div>
                        </div>
                      )}
                      {deliveryQuoteError && (
                        <div className="text-xs text-destructive" data-testid="text-uber-quote-error">{deliveryQuoteError}</div>
                      )}
                    </div>
                  )}
              </div>

            <div className="rounded-sm border border-border/50 bg-background p-4 space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                <PackageCheck size={14} /> 2. Confirm Order is Correct
              </div>
              <Textarea
                placeholder="Order notes (optional)"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="resize-none h-20 rounded-sm bg-background"
                data-testid="input-notes"
              />
              <CatalogNotice />
              <div className="rounded-sm border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground leading-relaxed">
                {CONVERSION_NOTE}
              </div>

                <label className="flex items-start gap-3 text-sm leading-relaxed">
                  <input
                    type="checkbox"
                    checked={acceptedFinalSale}
                    onChange={(e) => setAcceptedFinalSale(e.target.checked)}
                    className="mt-1 size-4 accent-primary"
                    data-testid="checkbox-all-sales-final"
                  />
                  <span>
                    <span className="font-semibold">All Sales Final confirmation.</span>{" "}
                    <span className="text-muted-foreground">{FINAL_SALE_TEXT}</span>
                  </span>
                </label>

                <label className="flex items-center gap-3 text-sm leading-relaxed cursor-pointer">
                  <input
                    type="checkbox"
                    checked={smsOptIn}
                    onChange={(e) => setSmsOptIn(e.target.checked)}
                    className="size-4 accent-primary"
                    data-testid="checkbox-sms-opt-in"
                  />
                  <span className="text-muted-foreground text-xs">
                    Send me text alerts for order status updates. <span className="text-muted-foreground/60">Reply STOP at any time.</span>
                  </span>
                </label>
            </div>

            <div className="rounded-sm border border-border/50 bg-background p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                <Wand2 size={14} /> 3. Convert Shopping Cart
              </div>
              {promotedItems.length > 0 && (
                <div className="rounded-sm border border-primary/20 bg-primary/5 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">Need one last item?</div>
                      <div className="text-xs text-muted-foreground">Supervisor-selected add-ons can be added before Zappy converts the cart.</div>
                    </div>
                    {reviewedLastItemPrompt && <CheckCircle2 size={17} className="text-emerald-500 shrink-0" />}
                  </div>
                  <div className="space-y-2">
                    {promotedItems.slice(0, 3).map(item => (
                      <div key={item.id} className="flex items-center gap-3 rounded-sm border border-border/50 bg-background p-2">
                        {item.imageUrl ? (
                          <img src={item.imageUrl} alt={item.name} className="h-10 w-10 rounded-sm object-cover bg-muted shrink-0" />
                        ) : (
                          <div className="h-10 w-10 rounded-sm bg-muted shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold truncate">{item.name}</div>
                          <div className="text-[11px] text-muted-foreground font-mono">${item.price.toFixed(2)}</div>
                        </div>
                        <Button type="button" size="sm" variant="ghost" className="h-7 rounded-sm px-2 text-[10px] uppercase tracking-wider" onClick={() => addPromotedToCart(item)} data-testid={`button-last-item-add-${item.id}`}>
                          Add
                        </Button>
                      </div>
                    ))}
                  </div>
                  {!reviewedLastItemPrompt && (
                    <Button type="button" variant="outline" className="w-full h-8 rounded-sm text-xs" onClick={() => setReviewedLastItemPrompt(true)} data-testid="button-last-item-no-thanks">
                      No thanks, continue
                    </Button>
                  )}
                </div>
              )}
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full rounded-sm h-10 text-xs font-semibold uppercase tracking-wider"
                disabled={cart.length === 0 || !acceptedFinalSale || !deliveryReady || lastItemPromptRequired || isConverting}
                  onClick={handlePreviewConversion}
                  data-testid="button-preview-conversion"
                >
                  <Wand2 size={15} className="mr-2" />
                {isConverting ? "Converting..." : "Convert Shopping Cart"}
                </Button>
                {conversionError && (
                  <div className="text-xs text-destructive" data-testid="text-conversion-error">{conversionError}</div>
                )}
              {conversionPreview && (
                <div className="rounded-sm border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-700" data-testid="conversion-ready">
                  Shopping cart converted. Payment options are ready.
                </div>
              )}
            </div>

            <div className="rounded-sm border border-border/50 bg-background p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                <CreditCard size={14} /> 4. Select Payment Option & Pay
              </div>
              {conversionPreview ? (
                <div className="space-y-4">
                  <div className="rounded-sm border border-primary/20 bg-primary/5 p-3 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <HandCoins size={16} className="text-primary" />
                      Add a tip for the sales rep preparing this order?
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                      {[
                        { id: "none", label: "No Tip" },
                        { id: "10", label: "10%" },
                        { id: "15", label: "15%" },
                        { id: "20", label: "20%" },
                        { id: "custom", label: "Custom" },
                      ].map(option => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => setTipMode(option.id as typeof tipMode)}
                          className={`rounded-sm border px-2 py-2 text-xs font-semibold transition-colors ${tipMode === option.id ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-background text-muted-foreground hover:border-primary/40"}`}
                          data-testid={`tip-option-${option.id}`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    {tipMode === "custom" && (
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={customTip}
                        onChange={e => setCustomTip(e.target.value)}
                        placeholder="Custom tip amount"
                        className="h-9 rounded-sm bg-background"
                        data-testid="input-custom-tip"
                      />
                    )}
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Tip selected</span>
                      <span className="font-mono">${tipAmount.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {conversionPreview.converted.paymentMethods.map(method => {
                      const Icon = method.id === "cash" ? Banknote : method.id === "stripe" ? CreditCard : method.id === "gift_card" ? Gift : CheckCircle2;
                      const active = selectedPaymentMethod === method.id;
                      return (
                        <button
                          key={method.id}
                          type="button"
                          onClick={() => setSelectedPaymentMethod(method.id)}
                          className={`rounded-sm border p-3 text-left transition-colors ${active ? "border-primary bg-primary/10" : "border-border/50 bg-background hover:border-primary/40"}`}
                          data-testid={`payment-method-${method.id}`}
                        >
                          <span className="flex items-center gap-2 text-sm font-semibold">
                            <Icon size={16} className={method.promoted ? "text-emerald-500" : "text-primary"} />
                            {method.label}
                          </span>
                          {method.message && <span className="block mt-1 text-[11px] text-emerald-600">{method.message}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="rounded-sm border border-dashed border-border/50 p-4 text-center text-xs text-muted-foreground">
                  Payment options appear after the shopping cart is converted.
                </div>
              )}

              <Button 
                className="w-full rounded-sm h-12 text-sm font-semibold uppercase tracking-wider" 
                disabled={!canSubmit}
                onClick={handleSubmit}
                data-testid="button-submit-order"
              >
                {paymentBusy ? "Processing Payment..." : `Pay & Send Order · $${displayedTotal.toFixed(2)}`}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Zappy Suggestions + Product Conversion */}
        <Card className="overflow-hidden rounded-sm border-border/50 shadow-sm bg-primary/5 border-primary/20">
          <CardHeader className="pb-3 shrink-0 border-b border-primary/10">
            <button
              type="button"
              className="w-full flex items-center justify-between gap-2 text-left"
              onClick={() => setZappyOpen(o => !o)}
              aria-expanded={zappyOpen}
              data-testid="button-zappy-toggle"
            >
              <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2 text-primary">
                <Sparkles size={16} /> Zappy Suggests
              </CardTitle>
              <span className="text-primary/60 shrink-0">
                {zappyOpen ? <Minus size={14} /> : <Plus size={14} />}
              </span>
            </button>
          </CardHeader>
          {zappyOpen && <CardContent className="p-4">
            {conversionPreview ? (
              <div className="space-y-4" data-testid="conversion-preview">
                <div className="rounded-sm border border-primary/25 bg-background/95 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-primary text-xs font-semibold uppercase tracking-wider">
                    <ShieldCheck size={15} /> {conversionPreview.converted.brandName}
                  </div>
                  <div className="text-base font-semibold leading-tight">{conversionPreview.converted.headline}</div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{conversionPreview.converted.zappyMessage}</p>
                </div>
                <div className="space-y-3">
                  {conversionPreview.converted.items.map(item => (
                    <div key={item.catalogItemId} className="rounded-sm overflow-hidden border border-primary/20 bg-background shadow-sm" data-testid={`converted-item-${item.catalogItemId}`}>
                      {item.displayImage && (
                        <div className="h-24 bg-muted/30 overflow-hidden">
                          <img src={item.displayImage} alt={item.displayName} className="h-full w-full object-cover" />
                        </div>
                      )}
                      <div className="p-3 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="text-[10px] uppercase tracking-widest text-primary">{item.displayCategory}</div>
                            <div className="font-semibold text-sm leading-tight">{item.displayName}</div>
                          </div>
                          <div className="font-mono text-xs">${item.lineSubtotal.toFixed(2)}</div>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed">{item.displayDescription}</p>
                        <p className="text-xs text-primary/90 leading-relaxed">{item.marketingCopy}</p>
                        {item.promoBadges.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {item.promoBadges.map(badge => (
                              <span key={badge} className="rounded-sm border border-primary/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">
                                {badge}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : upsellMutation.isPending ? (
              <div className="flex flex-col items-center justify-center h-full text-primary/60 space-y-3">
                <div className="flex gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-pulse"></div>
                  <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-pulse delay-75"></div>
                  <div className="w-1.5 h-1.5 rounded-full bg-primary/80 animate-pulse delay-150"></div>
                </div>
                <div className="text-xs font-mono uppercase tracking-wider">Analyzing cart...</div>
              </div>
            ) : !upsellMutation.data?.suggestions || upsellMutation.data.suggestions.length === 0 ? (
              <div className="text-center py-8 text-primary/50 text-xs font-mono uppercase tracking-wider">
                Add items to see AI recommendations.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="text-xs text-primary/80 leading-relaxed mb-4">
                  {upsellMutation.data.reasoning || "Based on the current cart, these additions are recommended:"}
                </div>
                {upsellMutation.data.suggestions.map(item => (
                  <div key={item.id} className="bg-background border border-primary/20 p-3 rounded-sm shadow-sm" data-testid={`upsell-item-${item.id}`}>
                    <div className="font-medium text-sm mb-1">{item.name}</div>
                    <div className="flex items-center justify-between mt-2">
                      <div className="text-xs font-mono text-muted-foreground">${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 hover:bg-primary/10 hover:text-primary rounded-sm uppercase tracking-wider" onClick={() => addToCart(item)} data-testid={`button-upsell-add-${item.id}`}>
                        Add
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>}
        </Card>
      </div>
    </div>
  );
}
