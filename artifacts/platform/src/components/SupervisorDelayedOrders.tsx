import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { useAuth } from "@clerk/react";
import { Link } from "wouter";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { useOrderEvents } from "@/hooks/useOrderEvents";

type DelayedRow = {
  id: number;
  customerName: string;
  customerId: number;
  assignedCsrUserId: number | null;
  fulfillmentStatus: string | null;
  estimatedReadyAt: string | null;
  total: number;
};

/**
 * not yet `ready` / `completed`. Polls /api/orders/delayed every 30s and
 * also refetches whenever an `order.updated` or `order.ready` SSE event
 * lands so newly-recovered orders disappear immediately.
 */
export function SupervisorDelayedOrders() {
  const { getToken } = useAuth();
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const [rows, setRows] = useState<DelayedRow[]>([]);
  const [loading, setLoading] = useState(true);

  const isSupervisor = user?.role === "admin" || user?.role === "supervisor";

  const reload = async () => {
    if (!isSupervisor) { setLoading(false); return; }
    try {
      const token = await getToken();
      const r = await fetch("/api/orders/delayed", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;
      const body = await r.json() as { orders: DelayedRow[] };
      setRows(body.orders ?? []);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (!isSupervisor) return;
    void reload();
    const t = setInterval(() => void reload(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupervisor]);

  useOrderEvents((ev) => {
    if (!isSupervisor) return;
    if (ev.type === "order.ready" || ev.type === "order.updated") void reload();
  });

  if (!isSupervisor) return null;
  if (loading) return null;
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border/40 bg-card/40 p-4 text-xs text-muted-foreground" data-testid="delayed-orders-empty">
        No delayed orders right now — every active hourglass is on time.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-5 space-y-3" data-testid="delayed-orders-panel">
      <div className="flex items-center gap-2 text-amber-300 font-bold text-sm">
        <AlertTriangle size={16} />
        {rows.length} order{rows.length === 1 ? "" : "s"} past the promised time
      </div>
      <ul className="divide-y divide-amber-500/20">
        {rows.map(o => {
          const lateMin = o.estimatedReadyAt
            ? Math.max(0, Math.floor((Date.now() - new Date(o.estimatedReadyAt).getTime()) / 60_000))
            : 0;
          return (
            <li
              key={o.id}
              className="py-2 flex items-center justify-between gap-3 text-xs"
              data-testid={`delayed-order-${o.id}`}
            >
              <div className="min-w-0">
                <div className="font-mono text-amber-200">#{o.id} · {o.customerName || `customer ${o.customerId}`}</div>
                <div className="text-amber-300/70">
                  {o.fulfillmentStatus ?? "submitted"}
                  {" · "}
                  {lateMin}m past promised time
                  {" · "}
                  CSR {o.assignedCsrUserId ?? "general queue"}
                </div>
              </div>
              <Link
                href={`/orders/${o.id}`}
                className="text-amber-300 hover:text-amber-200 inline-flex items-center gap-1"
                data-testid={`delayed-order-link-${o.id}`}
              >
                view <ExternalLink size={12} />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
