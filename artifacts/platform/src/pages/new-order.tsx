import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useCreateOrder, useListCatalogItems, useAiUpsellSuggestions, useGetCurrentUser } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Search, Plus, Minus, Trash, Sparkles } from "lucide-react";
import { usePushNotifications } from "@/hooks/usePushNotifications";

export default function NewOrder() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<{id: number, name: string, price: number, quantity: number}[]>([]);
  const [shippingAddress, setShippingAddress] = useState("");
  const [notes, setNotes] = useState("");
  const prevCartRef = useRef("");

  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const { notifyOrderPlaced } = usePushNotifications({
    role: (user?.role || "customer") as "customer" | "staff" | "tenant_admin" | "global_admin",
  });

  const { data: catalog } = useListCatalogItems(
    { search, limit: 10, available: true },
    { query: { queryKey: ["listCatalogItems", search, true] } }
  );

  const createOrderMutation = useCreateOrder();
  const upsellMutation = useAiUpsellSuggestions();

  useEffect(() => {
    const cartStr = cart.map(c=>c.id).sort().join(",");
    if (cart.length > 0 && cartStr !== prevCartRef.current) {
      prevCartRef.current = cartStr;
      upsellMutation.mutate({ data: { cartItemIds: cart.map(c=>c.id) } });
    }
  }, [cart, upsellMutation]);

  const addToCart = (item: any) => {
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

  const handleSubmit = () => {
    if (cart.length === 0) return;
    
    createOrderMutation.mutate(
      {
        data: {
          items: cart.map(i => ({ catalogItemId: i.id, quantity: i.quantity })),
          shippingAddress,
          notes
        }
      },
      {
        onSuccess: (order) => {
          notifyOrderPlaced(order.id, user?.firstName || undefined);
          // Track this session's orders for session-only history (customers)
          try {
            const existing = JSON.parse(sessionStorage.getItem("alavont_session_orders") || "[]");
            sessionStorage.setItem("alavont_session_orders", JSON.stringify([...existing, order.id]));
          } catch {}
          setLocation(`/orders/${order.id}`);
        }
      }
    );
  };

  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

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
            <CardTitle className="text-sm font-semibold uppercase tracking-wider">Current Build</CardTitle>
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
                <Input 
                  placeholder="Shipping Address (Optional)" 
                  value={shippingAddress}
                  onChange={e => setShippingAddress(e.target.value)}
                  className="rounded-sm bg-background"
                  data-testid="input-shipping"
                />
                <Textarea 
                  placeholder="Order Notes (Optional)" 
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  className="resize-none h-16 rounded-sm bg-background"
                  data-testid="input-notes"
                />
              </div>

              <div className="flex items-center justify-between text-lg pt-2 border-t border-border/50">
                <span className="font-medium text-muted-foreground">Total</span>
                <span className="font-bold tracking-tight" data-testid="text-total">${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>

              <Button 
                className="w-full rounded-sm h-12 text-sm font-semibold uppercase tracking-wider" 
                disabled={cart.length === 0 || createOrderMutation.isPending}
                onClick={handleSubmit}
                data-testid="button-submit-order"
              >
                {createOrderMutation.isPending ? "Processing..." : "Commit Order"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* AI Upsell Suggestions */}
        <Card className="lg:col-span-3 flex flex-col overflow-hidden rounded-sm border-border/50 shadow-sm bg-primary/5 border-primary/20">
          <CardHeader className="pb-3 shrink-0 border-b border-primary/10">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2 text-primary">
              <Sparkles size={16} /> Intelligence
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto p-4">
            {upsellMutation.isPending ? (
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
