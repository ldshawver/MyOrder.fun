import { useState, useRef, useEffect } from "react";
import { useGetCurrentUser, useGetTenantSummary, useGetRecentOrders, useListCatalogItems, useAiConciergeChat, AiChatMessage, type UserProfile, type CatalogItem } from "@workspace/api-client-react";
import { Link } from "wouter";
import { TrendingUp, Clock, Package, Users, ArrowRight, FlaskConical, Bot, User, Send, ShoppingCart, ImageOff, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/* ─── Metric card (admin/staff) ─────────────────────────── */
function MetricCard({ label, value, icon: Icon, color = "primary", link }: {
  label: string; value: string | number; icon: React.ElementType; color?: string; link?: string;
}) {
  const colorMap: Record<string, { bg: string; text: string; border: string }> = {
    primary: { bg: "bg-primary/10", text: "text-primary", border: "border-primary/20" },
    amber:   { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/20" },
    green:   { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20" },
    purple:  { bg: "bg-violet-500/10", text: "text-violet-400", border: "border-violet-500/20" },
  };
  const c = colorMap[color] || colorMap.primary;
  const inner = (
    <div className="glass-card card-hover-glow rounded-2xl p-5 space-y-4 h-full flex flex-col">
      <div className={`w-10 h-10 rounded-xl ${c.bg} border ${c.border} flex items-center justify-center shrink-0`}>
        <Icon size={18} className={c.text} />
      </div>
      <div className="flex-1">
        <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-widest mb-1">{label}</div>
        <div className="text-3xl font-bold tracking-tight text-foreground">{value}</div>
      </div>
    </div>
  );
  if (link) return <Link href={link} className="block h-full">{inner}</Link>;
  return <div className="h-full">{inner}</div>;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border status-${status.toLowerCase()} uppercase tracking-wide`}>
      {status}
    </span>
  );
}

/* ─── Compact AI Chat for customer home ────────────────── */
function MiniAssistant() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AiChatMessage[]>([
    { role: "assistant", content: "Hi! I'm your Alavont shopping assistant. Ask me about our products, pricing, or anything else — I'll help you find exactly what you need." }
  ]);
  const [suggested, setSuggested] = useState<CatalogItem[]>([]);
  const chatMutation = useAiConciergeChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, chatMutation.isPending]);

  const handleSend = () => {
    if (!input.trim() || chatMutation.isPending) return;
    const newMessages: AiChatMessage[] = [...messages, { role: "user" as const, content: input }];
    setMessages(newMessages);
    setInput("");
    chatMutation.mutate(
      { data: { messages: newMessages } },
      {
        onSuccess: res => {
          setMessages(prev => [...prev, { role: "assistant" as const, content: res.reply }]);
          if (res.suggestedItems?.length) setSuggested(res.suggestedItems);
        },
        onError: () => {
          setMessages(prev => [...prev, { role: "assistant" as const, content: "I'm having trouble right now. Please try again in a moment." }]);
        }
      }
    );
  };

  return (
    <div className="glass-card rounded-2xl overflow-hidden flex flex-col h-full" style={{ minHeight: 360 }}>
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/30">
        <div className="w-8 h-8 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center">
          <Sparkles size={15} className="text-primary" />
        </div>
        <div>
          <div className="text-sm font-bold">AI Shopping Assistant</div>
          <div className="text-[10px] text-muted-foreground font-mono">Alavont Therapeutics · Online</div>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-[10px] font-mono text-primary/70">
          <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          LIVE
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
        {messages.map((m, idx) => (
          <div key={idx} className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`} data-testid={`message-${idx}`}>
            <div className={`w-7 h-7 rounded-xl shrink-0 flex items-center justify-center ${m.role === "assistant" ? "bg-primary/15 border border-primary/20" : "bg-muted/50 border border-border/40"}`}>
              {m.role === "assistant" ? <Bot size={13} className="text-primary" /> : <User size={13} className="text-muted-foreground" />}
            </div>
            <div
              className={`max-w-[82%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === "assistant"
                  ? "bg-muted/30 border border-border/30 text-foreground"
                  : "bg-primary text-primary-foreground"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {chatMutation.isPending && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-xl shrink-0 bg-primary/15 border border-primary/20 flex items-center justify-center">
              <Bot size={13} className="text-primary" />
            </div>
            <div className="bg-muted/30 border border-border/30 rounded-2xl px-4 py-3 flex gap-1.5 items-center">
              {[0, 75, 150].map(d => (
                <div key={d} className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-pulse" style={{ animationDelay: `${d}ms` }} />
              ))}
            </div>
          </div>
        )}

        {/* Suggested items inline */}
        {suggested.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Suggested items</div>
            {suggested.slice(0, 3).map(item => (
              <Link key={item.id} href={`/catalog/${item.id}`} className="flex items-center gap-3 p-3 rounded-xl border border-border/30 hover:border-primary/40 bg-background/40 hover:bg-primary/5 transition-all group">
                <div className="w-10 h-10 rounded-lg bg-muted/30 shrink-0 overflow-hidden">
                  {item.imageUrl
                    ? <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center"><ImageOff size={12} className="text-muted-foreground/40" /></div>
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold truncate">{item.name}</div>
                  <div className="text-[10px] text-muted-foreground">{item.category}</div>
                </div>
                <div className="text-xs font-bold text-primary shrink-0">${Number(item.price).toFixed(2)}</div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 p-4 border-t border-border/30 bg-background/20">
        <form onSubmit={e => { e.preventDefault(); handleSend(); }} className="flex gap-2">
          <Input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask about products, pricing, availability..."
            className="flex-1 rounded-xl h-10 text-sm bg-background/60"
            data-testid="input-chat"
          />
          <Button type="submit" size="icon" className="h-10 w-10 rounded-xl shrink-0" disabled={!input.trim() || chatMutation.isPending} data-testid="button-send">
            <Send size={14} />
          </Button>
        </form>
      </div>
    </div>
  );
}

/* ─── Featured catalog items ────────────────────────────── */
function FeaturedItems() {
  const { data, isLoading } = useListCatalogItems(
    { limit: 8 },
    { query: { queryKey: ["listCatalogItemsDash"] } }
  );

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => <div key={i} className="aspect-square rounded-2xl bg-muted/20 animate-pulse" />)}
      </div>
    );
  }
  if (!data?.items?.length) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Featured</div>
        <Link href="/catalog" className="text-xs font-semibold text-primary hover:text-primary/80 flex items-center gap-1">
          View all <ArrowRight size={11} />
        </Link>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {data.items.slice(0, 8).map(item => (
          <Link
            key={item.id}
            href={`/catalog/${item.id}`}
            className="glass-card rounded-2xl overflow-hidden flex flex-col group hover:border-primary/40 transition-all hover:scale-[1.02]"
            data-testid={`card-featured-${item.id}`}
          >
            <div className="aspect-square bg-muted/10 overflow-hidden relative">
              {item.imageUrl ? (
                <img
                  src={item.imageUrl}
                  alt={item.name}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <FlaskConical size={20} className="text-muted-foreground/30" />
                </div>
              )}
            </div>
            <div className="p-3">
              <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-widest mb-0.5">{item.category}</div>
              <div className="text-xs font-bold leading-snug line-clamp-1">{item.name}</div>
              <div className="text-xs font-bold text-primary mt-1">${Number(item.price).toFixed(2)}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ─── Main export ───────────────────────────────────────── */
export default function Dashboard() {
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });

  /* Admin */
  if (user?.role === "admin") {
    return (
      <div className="space-y-8">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-semibold tracking-widest uppercase mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            Global Administration
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-dashboard-title">Platform Dashboard</h1>
          <p className="text-muted-foreground" data-testid="text-dashboard-subtitle">
            Welcome to the Alavont Therapeutics global administration center.
          </p>
        </div>
        <Link
          href="/global-admin"
          className="inline-flex items-center gap-2 text-sm font-semibold bg-primary/10 border border-primary/25 text-primary px-5 py-3 rounded-xl hover:bg-primary/20 transition-all"
          data-testid="link-global-admin"
        >
          Enter Global Admin Console <ArrowRight size={15} />
        </Link>
      </div>
    );
  }

  /* User — primary shop experience */
  if (user?.role === "user") {
    return <CustomerHome user={user} />;
  }

  /* Supervisor / business_sitter — metrics dashboard */
  return <AdminDashboard />;
}

/* ─── Customer shopping home ────────────────────────────── */
function CustomerHome({ user }: { user: UserProfile }) {
  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Hero header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <img
            src="/lc-icon.png"
            alt="Lucifer Cruz"
            className="w-14 h-14 object-contain"
            style={{ filter: "invert(1) brightness(1.1)" }}
            onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <div>
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Welcome back</div>
            <h1 className="text-2xl font-bold tracking-tight" data-testid="text-dashboard-title">
              {user?.firstName || (user as UserProfile & { contactName?: string })?.contactName || "Valued Client"}
            </h1>
            <div className="text-xs text-primary/80 font-medium tracking-wide mt-0.5">Lucifer Cruz · Adult Boutique</div>
          </div>
        </div>
        <Link
          href="/orders/new"
          className="hidden sm:inline-flex items-center gap-2 text-xs font-semibold bg-primary text-primary-foreground px-4 py-2.5 rounded-xl hover:opacity-90 transition-all shadow-lg shadow-primary/20"
          data-testid="link-new-order"
        >
          <ShoppingCart size={13} />
          New Order
        </Link>
      </div>

      {/* Security badge */}
      <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-primary/15 bg-primary/5">
        <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
        <span className="text-xs font-mono text-primary/70 tracking-widest uppercase">Secure Session Active · End-to-End Encrypted</span>
      </div>

      {/* AI + featured grid */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* AI assistant — left/top */}
        <div className="lg:col-span-2">
          <MiniAssistant />
        </div>
        {/* Featured items — right */}
        <div className="lg:col-span-3 space-y-5">
          <FeaturedItems />
          <Link
            href="/catalog"
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl border border-primary/20 text-primary text-sm font-semibold hover:bg-primary/10 transition-all"
          >
            <FlaskConical size={14} />
            Browse Full Menu
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ─── Admin / Staff metrics dashboard ───────────────────── */
const HOUSE_TENANT_ID = 1;
function AdminDashboard() {
  const { data: summary, isLoading: isLoadingSummary } = useGetTenantSummary(
    HOUSE_TENANT_ID,
    { query: { queryKey: ["getTenantSummary", HOUSE_TENANT_ID] } }
  );
  const { data: recentOrders, isLoading: isLoadingOrders } = useGetRecentOrders(
    { limit: 5 },
    { query: { queryKey: ["getRecentOrders"] } }
  );

  if (isLoadingSummary || isLoadingOrders) {
    return (
      <div className="animate-pulse space-y-8">
        <div className="h-9 bg-muted/30 rounded-xl w-48" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="h-32 bg-muted/20 rounded-2xl" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-64 bg-muted/20 rounded-2xl" />
          <div className="h-64 bg-muted/20 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-widest mb-1">Lucifer Cruz</div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-dashboard-title">Overview</h1>
          <p className="text-muted-foreground text-sm mt-1" data-testid="text-dashboard-subtitle">Real-time performance metrics</p>
        </div>
        <Link
          href="/orders/new"
          className="shrink-0 inline-flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-5 py-3 rounded-xl hover:opacity-90 transition-all shadow-lg shadow-primary/20"
          data-testid="link-new-order"
        >
          <Package size={15} /> New Order
        </Link>
      </div>

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard label="Total Revenue" value={`$${summary.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`} icon={TrendingUp} color="green" />
          <MetricCard label="Pending Orders" value={summary.pendingOrders} icon={Clock} color="amber" link="/orders" />
          <MetricCard label="Total Orders" value={summary.totalOrders} icon={Package} color="primary" link="/orders" />
          <MetricCard label="Active Customers" value={summary.totalCustomers} icon={Users} color="purple" />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/40">
            <h2 className="text-sm font-semibold uppercase tracking-wider">Recent Orders</h2>
            <Link href="/orders" className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 font-medium">View all <ArrowRight size={12} /></Link>
          </div>
          <div className="divide-y divide-border/30">
            {!recentOrders?.orders?.length ? (
              <div className="px-5 py-10 text-sm text-muted-foreground text-center">No recent orders.</div>
            ) : (
              recentOrders.orders.map(order => (
                <Link
                  key={order.id}
                  href={`/orders/${order.id}`}
                  className="flex items-center justify-between px-5 py-3.5 hover:bg-white/[0.02] transition-colors group cursor-pointer block"
                >
                  <div>
                    <div className="text-sm font-semibold group-hover:text-primary transition-colors">Order #{order.id}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{order.customerName} · {order.items.length} item{order.items.length !== 1 ? "s" : ""}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold">${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                    <StatusBadge status={order.status} />
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/40">
            <h2 className="text-sm font-semibold uppercase tracking-wider">Top Products</h2>
            <Link href="/catalog" className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 font-medium">Catalog <ArrowRight size={12} /></Link>
          </div>
          <div className="divide-y divide-border/30">
            {!summary?.topProducts?.length ? (
              <div className="px-5 py-10 text-sm text-muted-foreground text-center">No products data yet.</div>
            ) : (
              summary.topProducts.map((product, idx) => (
                <div key={product.id || idx} className="flex items-center justify-between px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">{idx + 1}</div>
                    <div className="text-sm font-medium">{product.name}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold">{product.orderCount} orders</div>
                    <div className="text-xs text-muted-foreground">${(product.revenue || 0).toLocaleString(undefined, { minimumFractionDigits: 0 })}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
