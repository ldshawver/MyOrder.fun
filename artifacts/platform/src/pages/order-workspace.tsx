import { Link } from "wouter";
import { useListOrders } from "@workspace/api-client-react";
import { BookOpen, ChevronRight, ClipboardList, CreditCard, ShoppingCart, Sparkles } from "lucide-react";
import { useCart } from "@/contexts/CartContext";
import AiConcierge from "@/pages/ai-concierge";

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, char => char.toUpperCase());
}

/** The customer ordering workspace composes the existing authoritative flows.
 * Cart and order data remain sourced from their existing providers/API hooks;
 * this page only gives customers one place to move through the journey.
 */
export default function OrderWorkspace() {
  const { cart, itemCount, cartTotal } = useCart();
  const { data } = useListOrders({ limit: 1 }, { query: { queryKey: ["workspace-current-order"] } });
  const currentOrder = data?.orders?.[0];

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-4" data-testid="customer-order-workspace">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-primary font-semibold">MyOrder</p>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Your ordering workspace</h1>
          <p className="text-sm text-muted-foreground mt-1">Browse, ask Zappy, review your cart, and follow your order in one place.</p>
        </div>
        <Link href="/catalog" className="hidden sm:inline-flex items-center gap-2 rounded-xl border border-border/50 px-4 py-2 text-sm font-semibold hover:bg-muted/30">
          <BookOpen size={16} /> Catalogue
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(170px,0.7fr)_minmax(320px,1.7fr)_minmax(220px,0.9fr)] gap-4 items-start">
        <aside className="glass-card rounded-2xl p-4 space-y-3 lg:sticky lg:top-4" aria-label="Ordering steps">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Order</div>
          <Link href="/catalog" className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm hover:bg-primary/10"><BookOpen size={16} /> Catalogue <ChevronRight size={14} className="ml-auto" /></Link>
          <Link href="/orders/new" className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm hover:bg-primary/10"><ShoppingCart size={16} /> Cart <span className="ml-auto text-xs text-muted-foreground">{itemCount}</span></Link>
          <Link href="/orders/new#checkout" className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm hover:bg-primary/10"><CreditCard size={16} /> Checkout <ChevronRight size={14} className="ml-auto" /></Link>
          <div className="border-t border-border/40 pt-3 text-xs text-muted-foreground">
            <div className="font-semibold text-foreground mb-1">Cart total</div>
            <div className="font-mono text-base">${cartTotal.toFixed(2)}</div>
            <div className="mt-1">Server totals are recalculated at checkout.</div>
          </div>
          {cart.length > 0 && <div className="text-xs text-muted-foreground">{cart.map(item => <div key={item.id} className="truncate">{item.quantity} × {item.name}</div>)}</div>}
        </aside>

        <section className="min-w-0 glass-card rounded-2xl overflow-hidden" aria-label="Zappy ordering assistant">
          <div className="px-5 py-3 border-b border-border/40 flex items-center gap-2"><Sparkles size={16} className="text-primary" /><span className="font-semibold">Zappy</span><span className="text-xs text-muted-foreground">Product discovery and suggestions</span></div>
          <div className="max-h-[720px] overflow-y-auto p-1"><AiConcierge /></div>
        </section>

        <aside className="glass-card rounded-2xl p-4 space-y-4 lg:sticky lg:top-4" aria-label="My Order status">
          <div className="flex items-center gap-2"><ClipboardList size={17} className="text-primary" /><h2 className="font-semibold">My Order</h2></div>
          {currentOrder ? (
            <>
              <div className="rounded-xl border border-border/40 p-3"><div className="text-xs text-muted-foreground">Order #{currentOrder.id}</div><div className="mt-1 font-semibold">{statusLabel(currentOrder.fulfillmentStatus ?? currentOrder.status)}</div><div className="text-xs text-muted-foreground mt-1">Payment: {statusLabel(currentOrder.paymentStatus)}</div></div>
              <Link href={`/orders/${currentOrder.id}`} className="inline-flex w-full justify-center rounded-xl bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground">View status</Link>
            </>
          ) : <div className="rounded-xl border border-dashed border-border/50 p-4 text-sm text-muted-foreground">No order yet. Your next order will appear here with its fulfillment progress.</div>}
          <Link href="/orders" className="block text-center text-xs text-primary hover:underline">Order history</Link>
        </aside>
      </div>
    </div>
  );
}
