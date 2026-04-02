import { useState } from "react";
import { useListOrders } from "@workspace/api-client-react";
import { Link } from "wouter";
import { ChevronRight, Package, Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";

const STATUS_TABS = [
  { value: "pending", label: "Incoming" },
  { value: "processing", label: "In Progress" },
  { value: "ready", label: "Ready" },
];

export default function BusinessSitterQueue() {
  const [activeTab, setActiveTab] = useState("pending");
  const queryClient = useQueryClient();

  const { data, isLoading } = useListOrders(
    { status: activeTab as any, limit: 50 },
    { query: { queryKey: ["listOrders", activeTab] } }
  );

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["listOrders"] });
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-title">
            Sitter Queue
          </h1>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-subtitle">
            Business sitter fulfillment dashboard
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-xl"
          onClick={refresh}
          title="Refresh"
        >
          <RefreshCw size={16} />
        </Button>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 p-1 bg-muted/20 border border-border/40 rounded-xl w-fit">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold tracking-wider uppercase transition-all ${
              activeTab === tab.value
                ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Order cards */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse bg-muted/20 rounded-2xl" />
          ))}
        </div>
      ) : data?.orders?.length === 0 ? (
        <div className="glass-card rounded-2xl flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-2xl bg-muted/20 flex items-center justify-center mb-4">
            <Package size={24} className="text-muted-foreground" />
          </div>
          <h3 className="font-semibold text-sm mb-1">Queue is clear</h3>
          <p className="text-xs text-muted-foreground">No {activeTab} orders right now.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data?.orders?.map((order) => (
            <Link key={order.id} href={`/orders/${order.id}`} data-testid={`row-queue-${order.id}`}>
              <div className="glass-card card-hover-glow rounded-2xl p-4 flex items-center gap-4 cursor-pointer group">
                {/* Order badge */}
                <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                  <span className="text-xs font-mono font-bold text-primary">#{order.id}</span>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold truncate">{order.customerName || "Unknown"}</span>
                    {(order as any).trackingUrl && (
                      <span className="text-[10px] font-mono bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/20">
                        Tracked
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock size={11} />
                      {new Date(order.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span>{order.items.length} item{order.items.length !== 1 ? "s" : ""}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-right">
                    <div className="text-sm font-bold font-mono">
                      ${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </div>
                  </div>
                  <ChevronRight
                    size={16}
                    className="text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all"
                    data-testid={`link-process-${order.id}`}
                  />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
