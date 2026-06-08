import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@clerk/react";
import { useCreateOrder, useListCatalogItems, useGetCatalogItem, useAiUpsellSuggestions, useGetCurrentUser, useTokenizePayment, useConfirmPayment, type CatalogItem } from "@workspace/api-client-react";
import { useCart } from "@/contexts/CartContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, Search, Plus, Minus, Trash, Sparkles, ShieldCheck, Wand2, Banknote, CreditCard, Gift, CheckCircle2, Truck, RefreshCw, ShoppingCart, MapPin, HandCoins, Package, Phone, ChevronRight, PartyPopper } from "lucide-react";
import { normalizeNotificationRole, usePushNotifications } from "@/hooks/usePushNotifications";
import { useBrand } from "@/contexts/BrandContext";
import { CatalogNotice } from "@/components/CatalogNotice";
import { useToast } from "@/hooks/use-toast";

type PromotedItem = { id: number; name: string; category: string; price: number; imageUrl: string | null; isAvailable: boolean };
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
    cashDiscount?: number;
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
      customerSafeName?: string;
      displayDescription: string;
      customerSafeDescription?: string;
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
  const { toast } = useToast();
  const { cart, addItem, removeItem, updateQuantity, clearCart } = useCart();
  const preItemId = parseInt(new URLSearchParams(window.location.search).get("item") || "0", 10) || undefined;
  const [search, setSearch] = useState("");

  // Checkout modal state
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutStep, setCheckoutStep] = useState<1 | 2>(1);

  // Delivery (in modal Step 1)
  const [shippingAddress, setShippingAddress] = useState("");
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>("pickup");
  const [deliveryQuote, setDeliveryQuote] = useState<DeliveryQuote | null>(null);
  const [deliveryQuoteError, setDeliveryQuoteError] = useState<string | null>(null);
  const [isQuotingDelivery, setIsQuotingDelivery] = useState(false);

  // Confirm (in modal Step 2)
  const [notes, setNotes] = useState("");
  const [acceptedOrderCorrect, setAcceptedOrderCorrect] = useState(false);
  const [acceptedFinalSale, setAcceptedFinalSale] = useState(false);
  const [smsPhone, setSmsPhone] = useState("");

  // Payment + conversion
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState("cash");
  const [conversionPreview, setConversionPreview] = useState<ConversionPreview | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [tipMode, setTipMode] = useState<"none" | "10" | "15" | "20" | "custom">("none");
  const [customTip, setCustomTip] = useState("");

  // Order submitted overlay
  const [orderSubmitted, setOrderSubmitted] = useState<{ orderId: number } | null>(null);

  // Delivery config from server (Uber capability + CSR personal delivery gate)
  const [deliveryConfig, setDeliveryConfig] = useState<{ uberEnabled: boolean; personalDeliveryEnabled: boolean } | null>(null);
  const [deliveryConfigError, setDeliveryConfigError] = useState(false);

  // Zappy / catalog
  const [promotedItems, setPromotedItems] = useState<PromotedItem[]>([]);
  const [reviewedLastItemPrompt, setReviewedLastItemPrompt] = useState(false);
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

  // Bug fix: use addItem (not replaceCart) so existing cart is preserved
  useEffect(() => {
    if (preItem && !preloaded.current) {
      preloaded.current = true;
      addItem({ id: preItem.id, name: preItem.name, price: preItem.price, imageUrl: preItem.imageUrl ?? null });
    }
  }, [preItem, addItem]);

  const catalogMode = brand === "lucifer_cruz" ? "lucifer" : "alavont";
  const { data: catalog } = useListCatalogItems(
    { search, limit: 100, available: true, mode: catalogMode },
    { query: { queryKey: ["listCatalogItems", search, true, catalogMode] } }
  );

  const createOrderMutation = useCreateOrder();
  const tokenizeMutation = useTokenizePayment();
  const confirmMutation = useConfirmPayment();
  const upsellMutation = useAiUpsellSuggestions();

  // Reset conversion when cart or delivery changes
  useEffect(() => {
    setConversionPreview(null);
    setConversionError(null);
  }, [cart, shippingAddress, notes, selectedPaymentMethod]);

  // Reset delivery quote when address/method changes
  useEffect(() => {
    setDeliveryQuote(null);
    setDeliveryQuoteError(null);
  }, [cart, shippingAddress, deliveryMethod]);

  useEffect(() => {
    getToken()
      .then(token => fetch("/api/orders/delivery-config", { headers: token ? { Authorization: `Bearer ${token}` } : {} }))
      .then(res => {
        if (!res.ok) throw new Error("config-load-failed");
        return res.json();
      })
      .then((cfg: { uberEnabled: boolean; personalDeliveryEnabled: boolean }) => {
        setDeliveryConfig(cfg);
        setDeliveryConfigError(false);
      })
      .catch(() => setDeliveryConfigError(true));
  }, [getToken]);

  useEffect(() => {
    getToken()
      .then(token => fetch("/api/concierge/promoted", { headers: token ? { Authorization: `Bearer ${token}` } : {} }))
      .then(res => res.ok ? res.json() : [])
      .then((items: PromotedItem[]) => setPromotedItems(Array.isArray(items) ? items.filter(item => item.isAvailable) : []))
      .catch(() => setPromotedItems([]));
  }, [getToken]);

  useEffect(() => {
    const cartStr = cart.map(c => c.id).sort().join(",");
    if (cart.length > 0 && cartStr !== prevCartRef.current) {
      prevCartRef.current = cartStr;
      upsellMutation.mutate({ data: { cartItemIds: cart.map(c => c.id) } });
    }
  }, [cart, upsellMutation]);

  const addToCart = (item: CatalogItem) => addItem(item);
  const addPromotedToCart = (item: PromotedItem) => {
    addItem(item);
    setReviewedLastItemPrompt(true);
  };

  const handleDeliveryQuote = async () => {
    if (cart.length === 0 || !shippingAddress.trim()) return;
    setIsQuotingDelivery(true);
    setDeliveryQuoteError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/orders/delivery-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          items: cart.map(i => ({ catalogItemId: i.id, quantity: i.quantity })),
          dropoffAddress: shippingAddress,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Uber Courier quote failed.");
      setDeliveryQuote(data as DeliveryQuote);
    } catch (e) {
      setDeliveryQuoteError(e instanceof Error ? e.message : "Uber Courier quote failed.");
    } finally {
      setIsQuotingDelivery(false);
    }
  };

  const handlePreviewConversion = async () => {
    if (cart.length === 0 || !acceptedFinalSale || !acceptedOrderCorrect) return;
    setIsConverting(true);
    setConversionError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/orders/preview-conversion", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          items: cart.map(i => ({ catalogItemId: i.id, quantity: i.quantity })),
          paymentMethod: selectedPaymentMethod,
          confirmation: {
            acceptedAllSalesFinal: true,
            confirmedAt: new Date().toISOString(),
            legalDisclaimerText: FINAL_SALE_TEXT,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Product conversion failed.");
      setConversionPreview(data as ConversionPreview);
    } catch (e) {
      setConversionError(e instanceof Error ? e.message : "Product conversion failed.");
    } finally {
      setIsConverting(false);
    }
  };

  const handleSubmit = async () => {
    if (cart.length === 0 || !conversionPreview) return;
    if (deliveryMethod === "uber_direct" && !deliveryQuote) return;
    if (deliveryMethod !== "pickup" && !shippingAddress.trim()) return;

    try {
      const order = await createOrderMutation.mutateAsync({
        data: {
          items: cart.map(i => ({ catalogItemId: i.id, quantity: i.quantity })),
          shippingAddress: deliveryMethod === "pickup" ? "" : shippingAddress,
          notes: [notes, smsPhone ? `SMS opt-in: ${smsPhone}` : ""].filter(Boolean).join(" | "),
          deliveryQuote: deliveryMethod === "uber_direct" && deliveryQuote ? deliveryQuote : undefined,
          checkoutConfirmation: {
            acceptedAllSalesFinal: true,
            confirmedAt: conversionPreview.confirmation.confirmedAt,
            legalDisclaimerText: conversionPreview.confirmation.legalDisclaimerText,
            paymentMethod: (selectedPaymentMethod === "zelle" ? "manual" : selectedPaymentMethod) as "cash" | "cash_app" | "stripe" | "venmo" | "gift_card" | "manual",
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

      try {
        const existing = JSON.parse(sessionStorage.getItem("alavont_session_orders") || "[]");
        sessionStorage.setItem("alavont_session_orders", JSON.stringify([...existing, order.id]));
      } catch { /* ignore storage errors */ }

      // Clear cart only after successful order
      clearCart();
      setCheckoutOpen(false);
      setOrderSubmitted({ orderId: order.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Order submission failed. Please try again.";
      toast({ title: "Could not place order", description: message, variant: "destructive" });
    }
  };

  // Derived values
  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const deliveryFee = deliveryMethod === "uber_direct" && deliveryQuote?.fee != null ? deliveryQuote.fee : 0;
  const tipBase = conversionPreview?.pricingSnapshot.subtotal ?? subtotal;
  const customTipAmount = Math.max(0, Number.parseFloat(customTip) || 0);
  const tipAmount = tipMode === "none"
    ? 0
    : tipMode === "custom"
      ? Math.round(customTipAmount * 100) / 100
      : Math.round(tipBase * (Number(tipMode) / 100) * 100) / 100;
  const cashDiscount = conversionPreview?.pricingSnapshot.cashDiscount ?? 0;
  const displayedTotal = (conversionPreview?.pricingSnapshot.total ?? subtotal) + deliveryFee + tipAmount;
  const deliveryReady = deliveryMethod === "pickup"
    || (deliveryMethod === "manual_delivery" && shippingAddress.trim().length > 0)
    || (deliveryMethod === "uber_direct" && !!deliveryQuote);
  const canProceedStep1 = deliveryReady;
  const canConvert = acceptedOrderCorrect && acceptedFinalSale && !isConverting;
  const paymentBusy = createOrderMutation.isPending || tokenizeMutation.isPending || confirmMutation.isPending;
  const canSubmit = cart.length > 0 && !!conversionPreview && deliveryReady && !paymentBusy;
  const canCurateSuggestions = user?.role === "customer_service_rep" || user?.role === "admin" || user?.role === "global_admin";
  const lastItemPromptRequired = promotedItems.length > 0 && cart.length > 0 && !reviewedLastItemPrompt;

  const openCheckout = () => {
    if (cart.length === 0) return;
    setCheckoutStep(1);
    setAcceptedOrderCorrect(false);
    setAcceptedFinalSale(false);
    setConversionPreview(null);
    setConversionError(null);
    setCheckoutOpen(true);
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto min-h-[calc(100vh-8rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 shrink-0 pb-4 border-b border-border/50">
        <Link href="/orders" className="text-muted-foreground hover:text-foreground transition-colors" data-testid="link-back">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-title">Cart & Checkout</h1>
          <p className="text-muted-foreground">Add items to your cart, then proceed to checkout.</p>
        </div>
        {cart.length > 0 && (
          <div className="ml-auto">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              <ShoppingCart size={13} /> {cart.reduce((s, i) => s + i.quantity, 0)} item{cart.reduce((s, i) => s + i.quantity, 0) !== 1 ? "s" : ""}
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(280px,0.75fr)] gap-6 items-start">
        {/* Receipt Cart */}
        <Card className="overflow-hidden rounded-sm border-border/50 shadow-sm bg-card">
          <CardHeader className="pb-3 bg-muted/10 border-b border-border/50">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2">
              <ShoppingCart size={16} /> Shopping Cart
            </CardTitle>
            <div className="relative mt-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
              <Input
                placeholder="Search and add items..."
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
                    onClick={() => { addToCart(item); setSearch(""); }}
                    data-testid={`catalog-item-${item.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt={item.name} className="h-9 w-9 rounded-sm object-cover bg-muted shrink-0" />
                      ) : (
                        <div className="h-9 w-9 rounded-sm bg-muted shrink-0 flex items-center justify-center">
                          <Package size={14} className="text-muted-foreground" />
                        </div>
                      )}
                      <span className="min-w-0">
                        <span className="block font-medium text-sm truncate">{item.name}</span>
                        <span className="block text-xs text-muted-foreground font-mono mt-0.5">${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      </span>
                    </div>
                    <Plus size={14} className="text-primary shrink-0" />
                  </button>
                ))}
                {catalog?.items?.length === 0 && (
                  <div className="text-center py-6 text-muted-foreground text-xs font-mono uppercase tracking-wider">No products found.</div>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent className="p-5">
            {cart.length === 0 ? (
              <div className="h-64 flex flex-col items-center justify-center text-center text-muted-foreground text-sm font-mono uppercase tracking-wider border border-dashed border-border/50 rounded-sm">
                <ShoppingCart size={28} className="mb-3 opacity-40" />
                <p>Cart is empty</p>
                <p className="text-xs mt-1 normal-case font-sans">Search for items above or browse the catalog</p>
              </div>
            ) : (
              <div className="space-y-1">
                {cart.map(item => (
                  <div key={item.id} className="flex items-center gap-3 rounded-sm border border-border/40 bg-background p-3" data-testid={`cart-item-${item.id}`}>
                    {/* Product image thumbnail */}
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt={item.name} className="h-14 w-14 rounded-sm object-cover bg-muted shrink-0" />
                    ) : (
                      <div className="h-14 w-14 rounded-sm bg-muted shrink-0 flex items-center justify-center">
                        <Package size={18} className="text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm leading-tight truncate">{item.name}</div>
                      <div className="text-xs text-muted-foreground font-mono mt-0.5">${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })} each</div>
                      {/* Qty controls */}
                      <div className="flex items-center gap-2 mt-2">
                        <div className="flex items-center border border-border/50 rounded-sm bg-background">
                          <button
                            className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => updateQuantity(item.id, -1)}
                            data-testid={`button-decrease-${item.id}`}
                          >
                            <Minus size={12} />
                          </button>
                          <span className="w-8 text-center text-xs font-mono font-semibold">{item.quantity}</span>
                          <button
                            className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => updateQuantity(item.id, 1)}
                            data-testid={`button-increase-${item.id}`}
                          >
                            <Plus size={12} />
                          </button>
                        </div>
                        <button
                          className="text-muted-foreground hover:text-destructive transition-colors p-1"
                          onClick={() => removeItem(item.id)}
                          data-testid={`button-remove-${item.id}`}
                        >
                          <Trash size={12} />
                        </button>
                      </div>
                    </div>
                    {/* Line subtotal */}
                    <div className="font-mono text-sm font-bold shrink-0">${(item.price * item.quantity).toFixed(2)}</div>
                  </div>
                ))}

                {/* Cart total summary */}
                <div className="border-t border-border/50 pt-3 mt-3 space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Subtotal ({cart.reduce((s, i) => s + i.quantity, 0)} items)</span>
                    <span className="font-mono">${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Tax & fees calculated at checkout</span>
                  </div>
                </div>

                {/* Proceed to Checkout */}
                <div className="pt-4">
                  {lastItemPromptRequired && (
                    <div className="mb-3 rounded-sm border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">
                      Supervisor-selected add-ons are available — review Zappy suggestions before proceeding.
                    </div>
                  )}
                  <Button
                    className="w-full h-12 text-sm font-semibold uppercase tracking-wider rounded-sm"
                    onClick={openCheckout}
                    disabled={cart.length === 0}
                    data-testid="button-proceed-checkout"
                  >
                    <ChevronRight size={16} className="mr-2" />
                    Proceed to Checkout · ${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Zappy Suggestions Sidebar */}
        <Card className="overflow-hidden rounded-sm border-primary/20 bg-primary/5 shadow-sm">
          <CardHeader className="pb-3 shrink-0 border-b border-primary/10">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2 text-primary">
              <Sparkles size={16} /> Zappy Suggestions
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {promotedItems.length > 0 && cart.length > 0 && (
              <div className="mb-4 rounded-sm border border-primary/20 bg-background/80 p-3 space-y-2">
                <div className="text-xs font-semibold text-primary">Supervisor-Selected Add-Ons</div>
                {promotedItems.slice(0, 3).map(item => (
                  <div key={item.id} className="flex items-center gap-3 rounded-sm border border-border/40 bg-background p-2">
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt={item.name} className="h-9 w-9 rounded-sm object-cover bg-muted shrink-0" />
                    ) : (
                      <div className="h-9 w-9 rounded-sm bg-muted shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold truncate">{item.name}</div>
                      <div className="text-[11px] text-muted-foreground font-mono">${item.price.toFixed(2)}</div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 rounded-sm px-2 text-[10px] uppercase tracking-wider"
                      onClick={() => addPromotedToCart(item)}
                      data-testid={`button-last-item-add-${item.id}`}
                    >
                      Add
                    </Button>
                  </div>
                ))}
                {!reviewedLastItemPrompt && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full h-7 rounded-sm text-xs"
                    onClick={() => setReviewedLastItemPrompt(true)}
                    data-testid="button-last-item-no-thanks"
                  >
                    No thanks
                  </Button>
                )}
              </div>
            )}

            {upsellMutation.isPending ? (
              <div className="flex flex-col items-center justify-center py-8 text-primary/60 space-y-3">
                <div className="flex gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-pulse" />
                  <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-pulse delay-75" />
                  <div className="w-1.5 h-1.5 rounded-full bg-primary/80 animate-pulse delay-150" />
                </div>
                <div className="text-xs font-mono uppercase tracking-wider">Analyzing cart...</div>
              </div>
            ) : !upsellMutation.data?.suggestions || upsellMutation.data.suggestions.length === 0 ? (
              <div className="text-center py-8 text-primary/50 text-xs font-mono uppercase tracking-wider">
                {cart.length === 0 ? "Add items to see AI recommendations." : "No suggestions for this cart."}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="text-xs text-primary/80 leading-relaxed">
                  {upsellMutation.data.reasoning || "Based on the current cart, these additions are recommended:"}
                  {!canCurateSuggestions && (
                    <span className="block mt-2 text-muted-foreground">
                      A Customer Service Specialist can select add-ons for this checkout.
                    </span>
                  )}
                </div>
                {upsellMutation.data.suggestions.map(item => (
                  <div key={item.id} className="bg-background border border-primary/20 p-3 rounded-sm shadow-sm" data-testid={`upsell-item-${item.id}`}>
                    <div className="font-medium text-sm mb-1">{item.name}</div>
                    <div className="flex items-center justify-between mt-2">
                      <div className="text-xs font-mono text-muted-foreground">${item.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] px-2 hover:bg-primary/10 hover:text-primary rounded-sm uppercase tracking-wider"
                        onClick={() => addToCart(item)}
                        disabled={!canCurateSuggestions}
                        data-testid={`button-upsell-add-${item.id}`}
                      >
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

      {/* Checkout Modal */}
      <Dialog open={checkoutOpen} onOpenChange={open => { if (!open) setCheckoutOpen(false); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto rounded-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold uppercase tracking-wider">
              {checkoutStep === 1 ? (
                <><MapPin size={16} /> Step 1 of 2 — Pickup or Delivery</>
              ) : (
                <><ShieldCheck size={16} /> Step 2 of 2 — Confirm & Pay</>
              )}
            </DialogTitle>
          </DialogHeader>

          {/* Step 1: Delivery Selection */}
          {checkoutStep === 1 && (
            <div className="space-y-5 pt-2">
              {deliveryConfigError && (
                <div className="rounded-md bg-destructive/10 border border-destructive/30 px-4 py-2.5 text-sm text-destructive">
                  Could not load delivery options. Pickup is available; other options may be unavailable until the page reloads.
                </div>
              )}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { id: "pickup", label: "Pickup", sub: "Ready at counter", disabled: false },
                  {
                    id: "manual_delivery",
                    label: "Delivery",
                    sub: deliveryConfig?.personalDeliveryEnabled
                      ? "CSR brings to you"
                      : "Requires CSR setup",
                    disabled: !deliveryConfig?.personalDeliveryEnabled,
                  },
                  {
                    id: "uber_direct",
                    label: "Uber Courier",
                    sub: deliveryConfig?.uberEnabled ? "Courier dispatch" : "Coming soon",
                    disabled: !deliveryConfig?.uberEnabled,
                  },
                ].map(option => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={option.disabled}
                    onClick={() => !option.disabled && setDeliveryMethod(option.id as DeliveryMethod)}
                    className={`rounded-sm border p-3 text-center transition-colors text-sm font-semibold ${
                      option.disabled
                        ? "border-border/30 bg-muted/10 text-muted-foreground/40 cursor-not-allowed"
                        : deliveryMethod === option.id
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/50 bg-muted/10 text-muted-foreground hover:border-primary/40"
                    }`}
                    data-testid={`delivery-method-${option.id}`}
                  >
                    <div>{option.label}</div>
                    <div className="text-[10px] font-normal mt-0.5 opacity-70">{option.sub}</div>
                  </button>
                ))}
              </div>

              {deliveryMethod !== "pickup" && (
                <div className="space-y-2">
                  <Input
                    placeholder="Delivery address"
                    value={shippingAddress}
                    onChange={e => setShippingAddress(e.target.value)}
                    className="rounded-sm bg-background"
                    data-testid="input-shipping"
                  />
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
                          </div>
                        </div>
                      )}
                      {deliveryQuoteError && (
                        <div className="text-xs text-destructive" data-testid="text-uber-quote-error">{deliveryQuoteError}</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <Textarea
                placeholder="Order notes (optional)"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="resize-none h-20 rounded-sm bg-background"
                data-testid="input-notes"
              />

              <div className="flex gap-3 pt-2">
                <Button variant="outline" className="flex-1 rounded-sm" onClick={() => setCheckoutOpen(false)}>
                  Cancel
                </Button>
                <Button
                  className="flex-1 rounded-sm font-semibold"
                  disabled={!canProceedStep1}
                  onClick={() => setCheckoutStep(2)}
                  data-testid="button-step1-next"
                >
                  Next — Confirm Order <ChevronRight size={15} className="ml-1" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 2: Confirm & Pay */}
          {checkoutStep === 2 && (
            <div className="space-y-5 pt-2">
              {/* Read-only cart summary */}
              <div className="rounded-sm border border-border/50 bg-background overflow-hidden">
                <div className="px-4 py-2 border-b border-border/40 text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <ShoppingCart size={13} /> Order Summary
                </div>
                <div className="divide-y divide-border/30">
                  {cart.map(item => (
                    <div key={item.id} className="flex items-center gap-3 p-3" data-testid={`summary-item-${item.id}`}>
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt={item.name} className="h-10 w-10 rounded-sm object-cover bg-muted shrink-0" />
                      ) : (
                        <div className="h-10 w-10 rounded-sm bg-muted shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{item.name}</div>
                        <div className="text-xs text-muted-foreground font-mono">×{item.quantity} @ ${item.price.toFixed(2)}</div>
                      </div>
                      <div className="font-mono text-sm font-semibold shrink-0">${(item.price * item.quantity).toFixed(2)}</div>
                    </div>
                  ))}
                </div>
                <div className="px-4 py-3 border-t border-border/40 flex justify-between text-sm font-semibold">
                  <span>Subtotal</span>
                  <span className="font-mono">${subtotal.toFixed(2)}</span>
                </div>
              </div>

              <CatalogNotice />

              {/* Confirmations */}
              <div className="space-y-3 rounded-sm border border-border/50 bg-background p-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Confirmations Required</div>
                <label className="flex items-start gap-3 text-sm leading-relaxed cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acceptedOrderCorrect}
                    onChange={e => setAcceptedOrderCorrect(e.target.checked)}
                    className="mt-0.5 size-4 accent-primary"
                    data-testid="checkbox-order-correct"
                  />
                  <span>
                    <span className="font-semibold">Order is correct.</span>{" "}
                    <span className="text-muted-foreground">I have reviewed the items, quantities, and prices above.</span>
                  </span>
                </label>
                <label className="flex items-start gap-3 text-sm leading-relaxed cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acceptedFinalSale}
                    onChange={e => setAcceptedFinalSale(e.target.checked)}
                    className="mt-0.5 size-4 accent-primary"
                    data-testid="checkbox-all-sales-final"
                  />
                  <span>
                    <span className="font-semibold">All sales are final.</span>{" "}
                    <span className="text-muted-foreground">{FINAL_SALE_TEXT}</span>
                  </span>
                </label>
              </div>

              {/* SMS opt-in */}
              <div className="rounded-sm border border-border/50 bg-background p-4">
                <label className="flex items-start gap-3 text-sm">
                  <Phone size={16} className="mt-0.5 text-muted-foreground shrink-0" />
                  <div className="flex-1">
                    <div className="font-semibold mb-1">Text Alerts (optional)</div>
                    <div className="text-xs text-muted-foreground mb-2">Get an SMS when your order is ready for pickup.</div>
                    <Input
                      type="tel"
                      placeholder="Phone number (e.g. 555-867-5309)"
                      value={smsPhone}
                      onChange={e => setSmsPhone(e.target.value)}
                      className="h-9 rounded-sm bg-muted/20"
                      data-testid="input-sms-phone"
                    />
                  </div>
                </label>
              </div>

              {/* Payment method selection (before conversion) */}
              <div className="rounded-sm border border-border/50 bg-background p-4 space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  <CreditCard size={14} /> Payment Method
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {[
                    { id: "cash", label: "Cash", Icon: Banknote, badge: "–10%", promoted: true },
                    { id: "cash_app", label: "Cash App", Icon: HandCoins, promoted: false },
                    { id: "zelle", label: "Zelle", Icon: HandCoins, promoted: false },
                    { id: "venmo", label: "Venmo", Icon: HandCoins, promoted: false },
                    { id: "gift_card", label: "Gift Card", Icon: Gift, promoted: false },
                    { id: "stripe", label: "Card", Icon: CreditCard, promoted: false },
                  ].map(({ id, label, Icon, badge, promoted }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setSelectedPaymentMethod(id)}
                      className={`rounded-sm border p-2.5 text-left transition-colors ${
                        selectedPaymentMethod === id
                          ? "border-primary bg-primary/10"
                          : "border-border/50 bg-background hover:border-primary/40"
                      }`}
                      data-testid={`payment-method-${id}`}
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold">
                        <Icon size={15} className={promoted ? "text-emerald-500" : "text-primary"} />
                        {label}
                        {badge && (
                          <span className="ml-auto text-[10px] font-bold text-emerald-600 bg-emerald-500/10 px-1.5 py-0.5 rounded-sm border border-emerald-500/20">
                            {badge}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
                {selectedPaymentMethod === "cash" && !conversionPreview && (
                  <div className="rounded-sm border border-emerald-500/20 bg-emerald-500/5 p-2.5 text-xs text-emerald-700">
                    Cash orders receive an automatic <strong>10% discount</strong> on the subtotal.
                  </div>
                )}
              </div>

              {/* Convert button */}
              {!conversionPreview && (
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full rounded-sm h-11 text-xs font-semibold uppercase tracking-wider"
                    disabled={!canConvert}
                    onClick={handlePreviewConversion}
                    data-testid="button-preview-conversion"
                  >
                    <Wand2 size={15} className="mr-2" />
                    {isConverting ? "Converting cart..." : "Convert & Preview Order"}
                  </Button>
                  {conversionError && (
                    <div className="text-xs text-destructive" data-testid="text-conversion-error">{conversionError}</div>
                  )}
                  {!canConvert && (acceptedOrderCorrect || acceptedFinalSale) && (
                    <div className="text-xs text-muted-foreground text-center">
                      {!acceptedOrderCorrect && 'Check "Order is correct" above.'}
                      {!acceptedFinalSale && ' Check "All sales are final" above.'}
                    </div>
                  )}
                </div>
              )}

              {/* Conversion preview + payment */}
              {conversionPreview && (
                <div className="space-y-4" data-testid="conversion-preview">
                  {/* Converted items */}
                  <div className="rounded-sm border border-primary/20 bg-primary/3 overflow-hidden">
                    <div className="px-4 py-2 border-b border-primary/15 bg-primary/5 flex items-center gap-2">
                      <ShieldCheck size={14} className="text-primary" />
                      <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                        {conversionPreview.converted.brandName} — Checkout Version
                      </span>
                    </div>
                    <div className="p-3 space-y-3">
                      <p className="text-xs text-muted-foreground leading-relaxed">{conversionPreview.converted.zappyMessage}</p>
                      {conversionPreview.converted.items.map(item => (
                        <div
                          key={item.catalogItemId}
                          className="rounded-sm border border-primary/15 bg-background overflow-hidden flex gap-3 p-3"
                          data-testid={`converted-item-${item.catalogItemId}`}
                        >
                          {item.displayImage && (
                            <img
                              src={item.displayImage}
                              alt={item.displayName}
                              className="h-16 w-16 rounded-sm object-cover bg-muted shrink-0"
                            />
                          )}
                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="text-[10px] uppercase tracking-widest text-primary">{item.displayCategory}</div>
                            <div className="font-semibold text-sm leading-tight">{item.customerSafeName ?? item.displayName}</div>
                            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                              {item.customerSafeDescription ?? item.displayDescription}
                            </p>
                            {item.promoBadges.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {item.promoBadges.map(badge => (
                                  <span key={badge} className="rounded-sm border border-primary/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-primary">
                                    {badge}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="font-mono text-xs font-bold shrink-0">${item.lineSubtotal.toFixed(2)}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Tip */}
                  <div className="rounded-sm border border-border/50 bg-background p-4 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      <HandCoins size={14} /> Add a tip for your sales rep?
                    </div>
                    <div className="grid grid-cols-5 gap-1.5">
                      {(["none", "10", "15", "20", "custom"] as const).map(opt => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => setTipMode(opt)}
                          className={`rounded-sm border px-2 py-2 text-xs font-semibold transition-colors ${tipMode === opt ? "border-primary bg-primary/10 text-primary" : "border-border/50 bg-background text-muted-foreground hover:border-primary/40"}`}
                          data-testid={`tip-option-${opt}`}
                        >
                          {opt === "none" ? "None" : opt === "custom" ? "Custom" : `${opt}%`}
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
                  </div>

                  {/* Price breakdown */}
                  <div className="rounded-sm border border-border/50 bg-background p-4 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Subtotal</span>
                      <span className="font-mono">${conversionPreview.pricingSnapshot.subtotal.toFixed(2)}</span>
                    </div>
                    {cashDiscount > 0 && (
                      <div className="flex justify-between text-emerald-600">
                        <span>Cash discount (–10%)</span>
                        <span className="font-mono">–${cashDiscount.toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Tax</span>
                      <span className="font-mono">${conversionPreview.pricingSnapshot.tax.toFixed(2)}</span>
                    </div>
                    {deliveryFee > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Uber Courier</span>
                        <span className="font-mono">${deliveryFee.toFixed(2)}</span>
                      </div>
                    )}
                    {tipAmount > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Tip</span>
                        <span className="font-mono">${tipAmount.toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-bold text-base pt-2 border-t border-border/40">
                      <span>Total</span>
                      <span className="font-mono" data-testid="text-total">${displayedTotal.toFixed(2)}</span>
                    </div>
                  </div>

                  {/* Submit */}
                  <Button
                    className="w-full h-12 text-sm font-semibold uppercase tracking-wider rounded-sm"
                    disabled={!canSubmit}
                    onClick={handleSubmit}
                    data-testid="button-submit-order"
                  >
                    {paymentBusy ? "Processing..." : `Pay & Submit Order · $${displayedTotal.toFixed(2)}`}
                  </Button>
                  {createOrderMutation.isError && (
                    <div className="text-xs text-destructive" data-testid="text-submit-error">
                      {createOrderMutation.error instanceof Error
                        ? createOrderMutation.error.message
                        : "Order submission failed. Please try again."}
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <Button
                  variant="outline"
                  className="flex-1 rounded-sm text-sm"
                  onClick={() => setCheckoutStep(1)}
                  disabled={paymentBusy}
                >
                  <ArrowLeft size={14} className="mr-1" /> Back
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Order Submitted Overlay */}
      {orderSubmitted && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm"
          data-testid="order-submitted-overlay"
        >
          <div className="flex flex-col items-center text-center space-y-6 max-w-sm px-6">
            <div className="relative">
              <div className="h-24 w-24 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                <PartyPopper size={48} className="text-emerald-400" />
              </div>
            </div>
            <div className="space-y-2">
              <h2 className="text-3xl font-bold tracking-tight text-emerald-400">Order Submitted!</h2>
              <p className="text-muted-foreground">
                Order <span className="font-mono font-semibold text-foreground">#{orderSubmitted.orderId}</span> has been placed and is in the queue.
              </p>
              <p className="text-sm text-muted-foreground">You'll be notified when it's ready.</p>
            </div>
            <div className="flex flex-col gap-3 w-full">
              <Button
                className="w-full rounded-sm font-semibold"
                onClick={() => {
                  setOrderSubmitted(null);
                  setLocation(`/orders/${orderSubmitted.orderId}`);
                }}
                data-testid="button-view-order"
              >
                <CheckCircle2 size={16} className="mr-2" />
                View Order Details
              </Button>
              <Button
                variant="outline"
                className="w-full rounded-sm"
                onClick={() => {
                  setOrderSubmitted(null);
                  setLocation("/orders");
                }}
                data-testid="button-back-to-orders"
              >
                Back to Orders
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
