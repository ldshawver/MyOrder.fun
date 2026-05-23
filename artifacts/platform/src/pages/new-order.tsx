import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@clerk/react";
import { useCreateOrder, useListCatalogItems, useGetCatalogItem, useAiUpsellSuggestions, useGetCurrentUser, type CatalogItem } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Search, Plus, Minus, Trash, Sparkles, ShieldCheck, Wand2, Banknote, CreditCard, Gift, CheckCircle2, Truck, RefreshCw } from "lucide-react";
import { normalizeNotificationRole, usePushNotifications } from "@/hooks/usePushNotifications";
import { useBrand } from "@/contexts/BrandContext";
import { CatalogNotice } from "@/components/CatalogNotice";

type CartItem = { id: number; name: string; price: number; quantity: number };
type DeliveryMethod = "pickup" | "manual_delivery" | "uber_direct";
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

export default function NewOrder() {
  const [, setLocation] = useLocation();
  const { brand } = useBrand();
  const preItemId = parseInt(new URLSearchParams(window.location.search).get("item") || "0", 10) || undefined;
  const [search, setSearch] = useState("");
  const [carts, setCarts] = useState<{ alavont: CartItem[]; lucifer_cruz: CartItem[] }>({
    alavont: [],
    lucifer_cruz: [],
  });
  const cart = carts[brand];
  const setCart = (updater: CartItem[] | ((prev: CartItem[]) => CartItem[])) => {
    setCarts(prev => ({
      ...prev,
      [brand]: typeof updater === "function" ? updater(prev[brand]) : updater,
    }));
  };
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
  const prevCartRef = useRef("");
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
      setCarts(prev => ({
        ...prev,
        [brand]: [{ id: preItem.id, name: preItem.name, price: preItem.price, quantity: 1 }],
      }));
    }
  }, [preItem, brand]);

  const catalogMode = brand === "lucifer_cruz" ? "lucifer" : "alavont";
  const { data: catalog } = useListCatalogItems(
    { search, limit: 100, available: true, mode: catalogMode },
    { query: { queryKey: ["listCatalogItems", search, true, catalogMode] } }
  );

  const createOrderMutation = useCreateOrder();
  const upsellMutation = useAiUpsellSuggestions();

  useEffect(() => {
    setConversionPreview(null);
    setConversionError(null);
  }, [cart, shippingAddress, notes]);

  useEffect(() => {
    setDeliveryQuote(null);
    setDeliveryQuoteError(null);
  }, [cart, shippingAddress, deliveryMethod]);

  useEffect(() => {
    const cartStr = cart.map(c=>c.id).sort().join(",");
    if (cart.length > 0 && cartStr !== prevCartRef.current) {
      prevCartRef.current = cartStr;
      upsellMutation.mutate({ data: { cartItemIds: cart.map(c=>c.id) } });
    }
  }, [cart, upsellMutation]);

  const addToCart = (item: CatalogItem) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === item.id);
      if (existing) {
        return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { id: item.id, name: item.name, price: item.price, quantity: 1 }];
    });
  };

  const updateQuantity = (id: number, delta: number) => {
    setCart(prev => prev.map(i => {
      if (i.id === id) {
        const newQ = Math.max(1, i.quantity + delta);
        return { ...i, quantity: newQ };
      }
      return i;
    }));
  };

  const removeFromCart = (id: number) => {
    setCart(prev => prev.filter(i => i.id !== id));
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

  const handleSubmit = () => {
    if (cart.length === 0 || !conversionPreview) return;
    if (deliveryMethod === "uber_direct" && !deliveryQuote) return;
    if (deliveryMethod !== "pickup" && !shippingAddress.trim()) return;
    
    createOrderMutation.mutate(
      {
        data: {
          items: cart.map(i => ({ catalogItemId: i.id, quantity: i.quantity })),
          shippingAddress: deliveryMethod === "pickup" ? "" : shippingAddress,
          notes,
          deliveryQuote: deliveryMethod === "uber_direct" && deliveryQuote ? deliveryQuote : undefined,
          checkoutConfirmation: {
            acceptedAllSalesFinal: true,
            confirmedAt: conversionPreview.confirmation.confirmedAt,
            legalDisclaimerText: conversionPreview.confirmation.legalDisclaimerText,
            paymentMethod: selectedPaymentMethod as "cash" | "cash_app" | "stripe" | "venmo" | "gift_card" | "manual",
          },
        }
      },
      {
        onSuccess: (order) => {
          notifyOrderPlaced(order.id, user?.firstName || undefined);
          // Track this session's orders for session-only history (customers)
          try {
            const existing = JSON.parse(sessionStorage.getItem("alavont_session_orders") || "[]");
            sessionStorage.setItem("alavont_session_orders", JSON.stringify([...existing, order.id]));
          } catch { /* ignore storage errors */ }
          setLocation(`/orders/${order.id}`);
        }
      }
    );
  };

  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const displayedTotal = conversionPreview?.pricingSnapshot.total ?? subtotal;
  const requiresDeliveryAddress = deliveryMethod !== "pickup";
  const deliveryReady = deliveryMethod === "pickup"
    || (deliveryMethod === "manual_delivery" && shippingAddress.trim().length > 0)
    || (deliveryMethod === "uber_direct" && !!deliveryQuote);

  return (
    <div className="space-y-6 max-w-7xl mx-auto h-[calc(100vh-8rem)] flex flex-col">
      <div className="flex items-center gap-4 shrink-0 pb-4 border-b border-border/50">
        <Link href="/orders" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-back">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-title">Draft Order</h1>
          <p className="text-muted-foreground">Construct a new manual order.</p>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 overflow-hidden">
        {/* Catalog Selection */}
        <Card className="lg:col-span-4 flex flex-col overflow-hidden rounded-sm border-border/50 shadow-sm">
          <CardHeader className="pb-3 shrink-0 bg-muted/10 border-b border-border/50">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Catalog</CardTitle>
            <div className="relative mt-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
              <Input 
                placeholder="Search products..." 
                className="pl-10 rounded-sm bg-background border-border"
                value={search}
                onChange={e => setSearch(e.target.value)}
                data-testid="input-search"
              />
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto p-2">
            <div className="space-y-1">
              {catalog?.items?.map(item => (
                <div key={item.id} className="flex items-center justify-between p-3 border border-transparent rounded-sm hover:bg-muted/50 hover:border-border/50 transition-colors group" data-testid={`catalog-item-${item.id}`}>
                  <div className="min-w-0 pr-2">
                    <div className="font-medium text-sm truncate">{item.name}</div>
                    <div className="text-xs text-muted-foreground font-mono mt-0.5">${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                  </div>
                  <Button size="sm" variant="secondary" className="h-7 text-xs px-3 rounded-sm opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => addToCart(item)} data-testid={`button-add-${item.id}`}>
                    Add
                  </Button>
                </div>
              ))}
              {catalog?.items?.length === 0 && (
                <div className="text-center py-12 text-muted-foreground text-sm font-mono uppercase tracking-wider">
                  No products found.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Cart & Checkout */}
        <Card className="lg:col-span-5 flex flex-col overflow-hidden rounded-sm border-border/50 shadow-sm">
          <CardHeader className="pb-3 shrink-0 bg-muted/10 border-b border-border/50">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Final Confirmation</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col overflow-hidden p-0">
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {cart.length === 0 ? (
                <div className="h-full flex items-center justify-center text-muted-foreground text-sm font-mono uppercase tracking-wider border border-dashed border-border/50 rounded-sm m-4">
                  Cart is empty.
                </div>
              ) : (
                cart.map(item => (
                  <div key={item.id} className="flex items-center justify-between border border-border/30 bg-muted/5 p-3 rounded-sm" data-testid={`cart-item-${item.id}`}>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate pr-4">{item.name}</div>
                      <div className="text-xs text-muted-foreground font-mono mt-0.5">${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <div className="flex items-center border border-border/50 rounded-sm bg-background">
                        <button className="px-2 py-1 text-muted-foreground hover:text-foreground transition-colors" onClick={() => updateQuantity(item.id, -1)} data-testid={`button-decrease-${item.id}`}><Minus size={12}/></button>
                        <span className="w-6 text-center text-xs font-mono font-medium">{item.quantity}</span>
                        <button className="px-2 py-1 text-muted-foreground hover:text-foreground transition-colors" onClick={() => updateQuantity(item.id, 1)} data-testid={`button-increase-${item.id}`}><Plus size={12}/></button>
                      </div>
                      <button className="text-muted-foreground hover:text-destructive transition-colors p-1" onClick={() => removeFromCart(item.id)} data-testid={`button-remove-${item.id}`}>
                        <Trash size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="shrink-0 space-y-4 p-4 border-t border-border/50 bg-muted/5">
              <div className="space-y-3">
                <div className="rounded-sm border border-border/50 bg-background p-3 space-y-3">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Fulfillment</div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: "pickup", label: "Pickup" },
                      { id: "manual_delivery", label: "Delivery" },
                      { id: "uber_direct", label: "Uber Courier" },
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
                <Textarea 
                  placeholder="Order Notes (Optional)" 
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  className="resize-none h-16 rounded-sm bg-background"
                  data-testid="input-notes"
                />
              </div>

              <CatalogNotice />

              <div className="rounded-sm border border-border/50 bg-background p-3 space-y-3">
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
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full rounded-sm h-10 text-xs font-semibold uppercase tracking-wider"
                  disabled={cart.length === 0 || !acceptedFinalSale || isConverting}
                  onClick={handlePreviewConversion}
                  data-testid="button-preview-conversion"
                >
                  <Wand2 size={15} className="mr-2" />
                  {isConverting ? "Converting..." : "Convert Products Before Payment"}
                </Button>
                {conversionError && (
                  <div className="text-xs text-destructive" data-testid="text-conversion-error">{conversionError}</div>
                )}
              </div>

              <div className="flex items-center justify-between text-lg pt-2 border-t border-border/50">
                <span className="font-medium text-muted-foreground">Total</span>
                <span className="font-bold tracking-tight" data-testid="text-total">${displayedTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
              {deliveryMethod === "uber_direct" && deliveryQuote?.fee != null && (
                <div className="flex items-center justify-between text-xs text-muted-foreground -mt-2">
                  <span>Uber Courier fee</span>
                  <span data-testid="text-uber-fee">${deliveryQuote.fee.toFixed(2)}</span>
                </div>
              )}

              <Button 
                className="w-full rounded-sm h-12 text-sm font-semibold uppercase tracking-wider" 
                disabled={cart.length === 0 || !conversionPreview || !deliveryReady || createOrderMutation.isPending}
                onClick={handleSubmit}
                data-testid="button-submit-order"
              >
                {createOrderMutation.isPending ? "Processing..." : "Create Order After Conversion"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* AI Upsell + Product Conversion */}
        <Card className="lg:col-span-3 flex flex-col overflow-hidden rounded-sm border-border/50 shadow-sm bg-primary/5 border-primary/20">
          <CardHeader className="pb-3 shrink-0 border-b border-primary/10">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2 text-primary">
              <Sparkles size={16} /> Zappy Checkout
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto p-4">
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
                <div className="space-y-2 pt-2 border-t border-primary/20">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-primary">Payment appears after conversion</div>
                  {conversionPreview.converted.paymentMethods.map(method => {
                    const Icon = method.id === "cash" ? Banknote : method.id === "stripe" ? CreditCard : method.id === "gift_card" ? Gift : CheckCircle2;
                    const active = selectedPaymentMethod === method.id;
                    return (
                      <button
                        key={method.id}
                        type="button"
                        onClick={() => setSelectedPaymentMethod(method.id)}
                        className={`w-full rounded-sm border p-3 text-left transition-colors ${active ? "border-primary bg-primary/10" : "border-border/50 bg-background hover:border-primary/40"}`}
                        data-testid={`payment-method-${method.id}`}
                      >
                        <span className="flex items-center gap-2 text-sm font-semibold">
                          <Icon size={16} className={method.promoted ? "text-emerald-500" : "text-primary"} />
                          {method.label}
                        </span>
                        {method.message && <span className="block mt-1 text-xs text-emerald-600">{method.message}</span>}
                      </button>
                    );
                  })}
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
