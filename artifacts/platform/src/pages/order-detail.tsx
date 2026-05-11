import { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import {
  useGetOrder,
  useGetOrderNotes,
  useAddOrderNote,
  useUpdateOrderStatus,
  useTokenizePayment,
  useConfirmPayment,
  getGetOrderQueryKey,
  getGetOrderNotesQueryKey,
  OrderPaymentStatus,
  OrderStatus,
  useGetCurrentUser,
  type Order,
} from "@workspace/api-client-react";

import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Lock, MessageSquare, CreditCard, Package, CheckCircle2, MapPin, ExternalLink, Truck } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import AnimatedHourglass from "@/components/AnimatedHourglass";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { CatalogNotice } from "@/components/CatalogNotice";
import { useOrderEvents } from "@/hooks/useOrderEvents";

type OrderWithTracking = Order & { trackingUrl?: string };

function CustomerHourglassPanel({ order }: { order: OrderWithTracking }) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useOrderEvents((ev) => {
    if (ev.orderId !== order.id) return;
    if (ev.type === "order.updated" || ev.type === "order.ready" || ev.type === "order.assigned") {
      queryClient.invalidateQueries({ queryKey: getGetOrderQueryKey(order.id) });
    }
  });

  const isReady = order.fulfillmentStatus === "ready" || order.status === "ready";
  const isCompleted = order.fulfillmentStatus === "completed" || order.status === "delivered";
  const etaForCheck = order.estimatedReadyAt ? new Date(order.estimatedReadyAt).getTime() : null;
  const timerExpired = etaForCheck !== null && now >= etaForCheck;
  const isCancelled = order.fulfillmentStatus === "cancelled" || order.status === "cancelled";

  if (isReady || isCompleted || (timerExpired && !isCancelled)) {
    return (
      <div
        className="glass-card rounded-2xl p-8 border border-emerald-500/30 bg-emerald-500/5 flex flex-col items-center text-center"
        data-testid="customer-ready-banner"
      >
        <CheckCircle2 size={56} className="text-emerald-400" />
        <div className="mt-4 text-2xl font-bold text-emerald-300">
          {isCompleted ? "Order Complete" : "Your order is ready for pickup"}
        </div>
        <p className="text-sm text-muted-foreground mt-2 max-w-sm" data-testid="customer-stage-message">
          {isReady || isCompleted
            ? stageMessageFor(order)
            : "Your order should be ready right about now — please head to the counter for pickup."}
        </p>
      </div>
    );
  }

  const eta = order.estimatedReadyAt ? new Date(order.estimatedReadyAt).getTime() : null;
  const routedAt = order.routedAt ? new Date(order.routedAt).getTime() : new Date(order.createdAt).getTime();
  const total = eta ? Math.max(1, eta - routedAt) : 0;
  const remaining = eta ? eta - now : 0;
  const overdue = remaining < 0;
  const absMs = Math.abs(remaining);
  const mins = Math.floor(absMs / 60000);
  const secs = Math.floor((absMs % 60000) / 1000);
  const pct = eta ? Math.max(0, Math.min(100, ((total - Math.max(0, remaining)) / total) * 100)) : 0;

  // Spec: the hourglass itself is time-driven (sand empties as the
  // promised window elapses). Stage messaging also progresses:
  // queued → preparing → almost-ready (>85% of window) → finishing-up.
  const progress = eta ? Math.max(0, Math.min(1, (now - routedAt) / total)) : 0;
  const almostReady = !overdue && progress >= 0.85;
  let message: string;
  if (overdue) {
    message = "Almost ready — our team is finishing up your order.";
  } else if (almostReady) {
    message = "Almost ready — just putting on the finishing touches.";
  } else if (order.fulfillmentStatus === "preparing" || order.fulfillmentStatus === "accepted") {
    message = "Our lab team is preparing your order...";
  } else if (order.status === "pending" || order.fulfillmentStatus === "submitted") {
    message = "Your order is in the queue waiting to be picked up...";
  } else {
    message = "Our lab team is working on your order...";
  }

  return (
    <div
      className="glass-card rounded-2xl p-8 border border-primary/20 bg-primary/3 flex flex-col items-center text-center"
      data-testid="customer-hourglass-panel"
    >
      <AnimatedHourglass size={200} message={message} progress={eta ? progress : undefined} />
      {eta && (
        <div className="mt-6 w-full max-w-sm" data-testid="hourglass-countdown">
          <div className={`font-mono text-3xl font-bold ${overdue ? "text-amber-400" : "text-primary"}`}>
            {overdue ? "almost ready" : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`}
          </div>
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground mt-1">
            {overdue ? "finishing up — we'll notify you the moment it's ready" : "estimated time remaining"}
          </div>
          <div className="mt-3 h-1.5 rounded-full bg-border/40 overflow-hidden">
            <div
              className={`h-full transition-all ${overdue ? "bg-amber-400" : "bg-primary"}`}
              style={{ width: `${overdue ? 100 : pct}%` }}
            />
          </div>
        </div>
      )}
      <p className="text-sm text-muted-foreground mt-4 max-w-sm" data-testid="customer-stage-message">
        {stageMessageFor(order)}
        {" "}You'll receive a push notification the moment it's ready.
      </p>
    </div>
  );
}

type ActiveCsrOption = { userId: number; shiftId: number; name: string; role: string | null };

function SupervisorRoutingPanel({
  order,
  getToken,
  onMutated,
}: {
  order: OrderWithTracking;
  getToken: () => Promise<string | null>;
  onMutated: () => void;
}) {
  const [etaMins, setEtaMins] = useState<string>(String(order.promisedMinutes ?? 30));
  const [etaAbsolute, setEtaAbsolute] = useState<string>(() => {
    const d = order.estimatedReadyAt ? new Date(order.estimatedReadyAt) : new Date(Date.now() + 30 * 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [reassignTo, setReassignTo] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [activeCsrs, setActiveCsrs] = useState<ActiveCsrOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await getToken();
      const res = await fetch("/api/orders/active-csrs", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok || cancelled) return;
      const json = (await res.json()) as { csrs: ActiveCsrOption[] };
      if (!cancelled) setActiveCsrs(json.csrs);
    })();
    return () => { cancelled = true; };
  }, [getToken]);

  const call = async (key: string, url: string, method: "POST" | "PATCH", body?: unknown) => {
    setBusy(key);
    try {
      const token = await getToken();
      await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      onMutated();
    } finally { setBusy(null); }
  };

  const setEta = (minutes: number) => {
    if (minutes <= 0) return;
    setEtaMins(String(minutes));
    void call("eta", `/api/orders/${order.id}/eta`, "PATCH", { promisedMinutes: minutes });
  };
  const bumpEta = (delta: number) => {
    // True delta against the existing estimatedReadyAt rather than a
    // reset-from-now: a +5 click on an order that was already ETA'd to
    // 12:30 should produce 12:35, not now+5min. Falls back to
    // routedAt+promisedMinutes if no ETA has been set yet.
    const baseMs = order.estimatedReadyAt
      ? new Date(order.estimatedReadyAt).getTime()
      : (order.routedAt ? new Date(order.routedAt).getTime() : Date.now())
        + (order.promisedMinutes ?? 30) * 60_000;
    const nextMs = baseMs + delta * 60_000;
    if (nextMs <= Date.now()) return;
    void call("eta", `/api/orders/${order.id}/eta`, "PATCH", { estimatedReadyAt: new Date(nextMs).toISOString() });
  };
  const setExplicitEta = () => {
    const n = parseInt(etaMins, 10);
    if (isNaN(n) || n <= 0) return;
    setEta(n);
  };
  const setAbsoluteEta = () => {
    const t = new Date(etaAbsolute);
    if (isNaN(t.getTime())) return;
    void call("eta", `/api/orders/${order.id}/eta`, "PATCH", { estimatedReadyAt: t.toISOString() });
  };
  const markReady = () => void call("ready", `/api/orders/${order.id}/mark-ready`, "POST");
  const reassign = () => {
    const id = reassignTo === "" || reassignTo === "__general__" ? null : parseInt(reassignTo, 10);
    if (id !== null && isNaN(id)) return;
    void call("reassign", `/api/orders/${order.id}/reassign`, "POST", { assignedCsrUserId: id });
  };

  return (
    <div className="glass-card rounded-2xl p-5 border border-border/50 space-y-4" data-testid="supervisor-routing-panel">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        <Truck size={14} /> Routing controls
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div className="space-y-0.5">
          <div className="text-muted-foreground">Assigned CSR</div>
          <div className="font-mono">{order.assignedCsrUserId ?? "— general queue —"}</div>
        </div>
        <div className="space-y-0.5">
          <div className="text-muted-foreground">Route source</div>
          <div className="font-mono">{order.routeSource ?? "n/a"}</div>
        </div>
        <div className="space-y-0.5">
          <div className="text-muted-foreground">Estimated ready</div>
          <div className="font-mono">{order.estimatedReadyAt ? new Date(order.estimatedReadyAt).toLocaleString() : "—"}</div>
        </div>
      </div>
      <div className="space-y-2 pt-2 border-t border-border/30">
        <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Adjust ETA</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => bumpEta(-5)} disabled={busy === "eta"} data-testid="button-eta-minus-5">−5 min</Button>
          <Button size="sm" variant="outline" onClick={() => bumpEta(5)} disabled={busy === "eta"} data-testid="button-eta-plus-5">+5 min</Button>
          <div className="flex items-end gap-1">
            <Input value={etaMins} onChange={(e) => setEtaMins(e.target.value)} className="w-24 h-9" data-testid="input-eta-minutes" placeholder="min" />
            <Button size="sm" onClick={setExplicitEta} disabled={busy === "eta"} data-testid="button-set-eta">Set minutes</Button>
          </div>
          <div className="flex items-end gap-1">
            <Input
              type="datetime-local"
              value={etaAbsolute}
              onChange={(e) => setEtaAbsolute(e.target.value)}
              className="w-56 h-9"
              data-testid="input-eta-absolute"
            />
            <Button size="sm" variant="outline" onClick={setAbsoluteEta} disabled={busy === "eta"} data-testid="button-set-eta-absolute">Set exact time</Button>
          </div>
          <Button size="sm" variant="default" onClick={markReady} disabled={busy === "ready"} data-testid="button-mark-ready">
            <CheckCircle2 size={14} className="mr-1.5" />
            Mark ready
          </Button>
        </div>
      </div>
      <div className="space-y-2 pt-2 border-t border-border/30">
        <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">Reassign to active CSR</Label>
        <div className="flex flex-wrap items-end gap-2">
          <Select value={reassignTo} onValueChange={setReassignTo}>
            <SelectTrigger className="w-64 h-9" data-testid="select-reassign-csr">
              <SelectValue placeholder="— General Account queue —" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__general__">— General Account queue —</SelectItem>
              {activeCsrs.map((c) => (
                <SelectItem key={c.userId} value={String(c.userId)} data-testid={`option-csr-${c.userId}`}>
                  {c.name} {c.role ? `· ${c.role}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={reassign} disabled={busy === "reassign"} data-testid="button-reassign">Reassign</Button>
        </div>
        {activeCsrs.length === 0 && (
          <p className="text-[11px] text-muted-foreground">No CSRs are currently clocked in — orders will go to the General Account queue.</p>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = `status-${status.toLowerCase()}`;
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border ${cls} uppercase tracking-wider`}>
      {status}
    </span>
  );
}

const STATUS_MESSAGES: Record<string, string> = {
  pending: "Your order has been received and is awaiting processing by our lab team.",
  processing: "Our lab technicians are actively working on your order.",
  ready: "Your order is ready! Please proceed to collect it.",
  delivered: "Your order has been successfully delivered.",
  cancelled: "This order has been cancelled.",
};

const FULFILLMENT_STAGE_MESSAGES: Record<string, string> = {
  submitted: "Order received — waiting for a customer service rep to pick it up.",
  accepted: "A customer service rep is preparing your order.",
  preparing: "Your order is being packaged discreetly for pickup.",
  ready: "Your order is ready for pickup or delivery.",
  completed: "Your order has been completed. Thanks for shopping with us!",
  cancelled: "This order has been cancelled.",
};

function stageMessageFor(order: { fulfillmentStatus?: string | null; status: string }): string {
  if (order.fulfillmentStatus && FULFILLMENT_STAGE_MESSAGES[order.fulfillmentStatus]) {
    return FULFILLMENT_STAGE_MESSAGES[order.fulfillmentStatus];
  }
  return STATUS_MESSAGES[order.status] ?? "";
}

export default function OrderDetail() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const queryClient = useQueryClient();

  const [noteContent, setNoteContent] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [trackingInput, setTrackingInput] = useState("");
  const [trackingSaving, setTrackingSaving] = useState(false);

  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const { getToken } = useAuth();
  const canEditStatus = user?.role === "admin" || user?.role === "supervisor" || user?.role === "business_sitter";
  const canManageRouting = user?.role === "admin" || user?.role === "supervisor";
  const isCustomer = user?.role === "user";

  const { notifyOrderStatusChange } = usePushNotifications({
    role: (user?.role || "user") as "user" | "business_sitter" | "supervisor" | "admin",
  });

  const { data: order, isLoading: isOrderLoading } = useGetOrder(
    id,
    { query: { enabled: !!id, queryKey: getGetOrderQueryKey(id) } }
  );

  const { data: notesRes, isLoading: isNotesLoading } = useGetOrderNotes(
    id,
    { query: { enabled: !!id, queryKey: getGetOrderNotesQueryKey(id) } }
  );

  const addNoteMutation = useAddOrderNote();
  const updateStatusMutation = useUpdateOrderStatus();
  const tokenizeMutation = useTokenizePayment();
  const confirmMutation = useConfirmPayment();

  const handleAddNote = () => {
    if (!noteContent.trim()) return;
    addNoteMutation.mutate(
      { id, data: { content: noteContent, isInternal, isEncrypted } },
      {
        onSuccess: () => {
          setNoteContent("");
          queryClient.invalidateQueries({ queryKey: getGetOrderNotesQueryKey(id) });
        }
      }
    );
  };

  const handleStatusChange = (status: OrderStatus) => {
    updateStatusMutation.mutate(
      { id, data: { status } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetOrderQueryKey(id) });
          notifyOrderStatusChange(id, status);
        }
      }
    );
  };

  const handlePay = () => {
    if (!order) return;
    tokenizeMutation.mutate(
      { data: { orderId: order.id, amount: order.total } },
      {
        onSuccess: (res) => {
          confirmMutation.mutate(
            { orderId: id, data: { paymentIntentId: res.paymentIntentId } },
            {
              onSuccess: () => {
                queryClient.invalidateQueries({ queryKey: getGetOrderQueryKey(id) });
              }
            }
          );
        }
      }
    );
  };

  // Sync tracking input when order loads
  useEffect(() => {
    if (order && (order as OrderWithTracking).trackingUrl) {
      setTrackingInput((order as OrderWithTracking).trackingUrl || "");
    }
  }, [order]);

  const handleSaveTracking = async () => {
    setTrackingSaving(true);
    try {
      const token = await getToken();
      await fetch(`/api/orders/${id}/tracking`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ trackingUrl: trackingInput.trim() || null }),
      });
      queryClient.invalidateQueries({ queryKey: getGetOrderQueryKey(id) });
    } finally {
      setTrackingSaving(false);
    }
  };

  const isPendingOrProcessing = order?.status === "pending" || order?.status === "processing";
  const isReady = order?.status === "ready";
  const isDelivered = order?.status === "delivered";

  if (isOrderLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <AnimatedHourglass size={160} message="Loading order details..." />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
        <Package size={32} className="text-muted-foreground mb-4" />
        <p className="text-muted-foreground">Order not found.</p>
        <Link href="/orders" className="text-primary hover:underline text-sm mt-2">Back to orders</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Back + title */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <Link
          href="/orders"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="link-back"
        >
          <ArrowLeft size={16} />
          Back to Orders
        </Link>
        <div className="sm:ml-auto flex items-center gap-3">
          <StatusBadge status={order.status} />
          {canEditStatus && (
            <Select value={order.status} onValueChange={(v) => handleStatusChange(v as OrderStatus)}>
              <SelectTrigger className="w-[150px] rounded-xl bg-card border-border/50 text-xs" data-testid="select-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                {Object.values(OrderStatus).map(status => (
                  <SelectItem key={status} value={status} className="text-xs uppercase">{status}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-order-id">
          Order #{order.id}
        </h1>
        <p className="text-muted-foreground text-sm mt-1 font-mono">
          {new Date(order.createdAt).toLocaleString()}
        </p>
      </div>

      {/* ── Customer waiting view: Hourglass with ETA countdown ────── */}
      {isCustomer && isPendingOrProcessing && (
        <CustomerHourglassPanel order={order as OrderWithTracking} />
      )}

      {canManageRouting && (
        <SupervisorRoutingPanel order={order as OrderWithTracking} getToken={getToken} onMutated={() => queryClient.invalidateQueries({ queryKey: getGetOrderQueryKey(id) })} />
      )}

      {/* ── Ready / Delivered banner ───────────────────────────────── */}
      {isCustomer && (isReady || isDelivered) && (
        <div className={`rounded-2xl p-5 border flex items-center gap-4 ${
          isReady
            ? "bg-emerald-500/10 border-emerald-500/25"
            : "bg-primary/5 border-primary/20"
        }`}>
          <CheckCircle2 size={24} className={isReady ? "text-emerald-400 shrink-0" : "text-primary shrink-0"} />
          <div>
            <div className={`font-semibold text-sm ${isReady ? "text-emerald-400" : "text-primary"}`}>
              {isReady ? "Your Order is Ready!" : "Order Delivered"}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {stageMessageFor(order)}
            </div>
          </div>
        </div>
      )}

      <CatalogNotice />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Manifest + Notes */}
        <div className="lg:col-span-2 space-y-6">
          {/* Manifest */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border/40 flex items-center gap-2">
              <Package size={15} className="text-muted-foreground" />
              <h2 className="text-sm font-semibold uppercase tracking-wider">Order Items</h2>
            </div>
            <div className="divide-y divide-border/30 px-5">
              {order.items.map(item => (
                <div key={item.id} className="flex items-center justify-between py-4">
                  <div>
                    <div className="font-medium text-sm">{item.catalogItemName}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                      ${item.unitPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })} × {item.quantity}
                    </div>
                  </div>
                  <div className="font-semibold text-sm font-mono">
                    ${item.totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </div>
                </div>
              ))}
            </div>
            <div className="px-5 pb-5 pt-2 border-t border-border/30 space-y-2.5 mt-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="font-mono">${order.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
              {order.tax !== undefined && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tax</span>
                  <span className="font-mono">${order.tax.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-base pt-2 border-t border-border/30 mt-1">
                <span>Total</span>
                <span className="font-mono">${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>

          {/* Notes / Audit trail */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border/40 flex items-center gap-2">
              <MessageSquare size={15} className="text-muted-foreground" />
              <h2 className="text-sm font-semibold uppercase tracking-wider">Notes & Audit Trail</h2>
            </div>
            <div className="p-5 space-y-5">
              <div className="space-y-3">
                {isNotesLoading ? (
                  <div className="text-sm text-muted-foreground animate-pulse">Loading notes...</div>
                ) : notesRes?.notes?.length === 0 ? (
                  <div className="text-sm text-muted-foreground text-center py-6 border border-dashed border-border/40 rounded-xl">
                    No notes yet.
                  </div>
                ) : (
                  notesRes?.notes?.map(note => (
                    <div
                      key={note.id}
                      className={`p-4 rounded-xl border ${
                        note.isInternal
                          ? "bg-primary/5 border-primary/20"
                          : "bg-card/50 border-border/40"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs">{note.authorName || "System"}</span>
                          {note.isInternal && (
                            <span className="px-1.5 py-0.5 bg-primary/10 text-primary text-[10px] rounded-full font-semibold">
                              Internal
                            </span>
                          )}
                          {note.isEncrypted && <Lock size={11} className="text-muted-foreground" />}
                        </div>
                        <span className="text-[10px] font-mono text-muted-foreground">
                          {new Date(note.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap leading-relaxed text-foreground/90">
                        {note.content}
                      </p>
                    </div>
                  ))
                )}
              </div>

              <div className="space-y-3 pt-4 border-t border-border/30">
                <Textarea
                  placeholder="Add a note..."
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  className="resize-none rounded-xl bg-background/50 border-border/50 focus:border-primary min-h-[80px]"
                  data-testid="input-note"
                />
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-5">
                    {canEditStatus && (
                      <div className="flex items-center gap-2">
                        <Switch id="internal" checked={isInternal} onCheckedChange={setIsInternal} data-testid="switch-internal" />
                        <Label htmlFor="internal" className="text-xs font-medium cursor-pointer">Internal</Label>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <Switch id="encrypted" checked={isEncrypted} onCheckedChange={setIsEncrypted} data-testid="switch-encrypted" />
                      <Label htmlFor="encrypted" className="text-xs font-medium cursor-pointer flex items-center gap-1.5">
                        <Lock size={11} /> Encrypt
                      </Label>
                    </div>
                  </div>
                  <Button
                    onClick={handleAddNote}
                    disabled={!noteContent.trim() || addNoteMutation.isPending}
                    className="rounded-xl font-semibold text-xs h-9 px-5"
                    data-testid="button-add-note"
                  >
                    {addNoteMutation.isPending ? "Saving..." : "Add Note"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-5">
          {/* Customer Details */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border/40">
              <h2 className="text-sm font-semibold uppercase tracking-wider">Customer</h2>
            </div>
            <div className="px-5 py-5 space-y-4">
              <div>
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest mb-1">Name</div>
                <div className="text-sm font-medium">{order.customerName || "—"}</div>
              </div>
              <div>
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest mb-1">Email</div>
                <div className="text-sm font-medium">{order.customerEmail || "—"}</div>
              </div>
              {order.shippingAddress && (
                <div>
                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest mb-1">Address</div>
                  <div className="text-sm whitespace-pre-wrap leading-relaxed">{order.shippingAddress}</div>
                </div>
              )}
            </div>
          </div>

          {/* Delivery Tracking */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border/40 flex items-center gap-2">
              <Truck size={14} className="text-muted-foreground" />
              <h2 className="text-sm font-semibold uppercase tracking-wider">Delivery</h2>
            </div>
            <div className="px-5 py-5 space-y-4">
              {/* Staff: paste tracking link */}
              {canEditStatus && (
                <div className="space-y-2">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">
                    Uber Courier Tracking Link
                  </div>
                  <Input
                    placeholder="https://track.uber.com/..."
                    value={trackingInput}
                    onChange={e => setTrackingInput(e.target.value)}
                    className="rounded-xl bg-background/50 border-border/50 text-xs h-9"
                    data-testid="input-tracking-url"
                  />
                  <Button
                    size="sm"
                    className="w-full rounded-xl text-xs h-9 font-semibold"
                    onClick={handleSaveTracking}
                    disabled={trackingSaving}
                    data-testid="button-save-tracking"
                  >
                    <MapPin size={13} className="mr-1.5" />
                    {trackingSaving ? "Saving..." : "Save Tracking Link"}
                  </Button>
                </div>
              )}

              {/* Customer: Track My Delivery button */}
              {isCustomer && (order as OrderWithTracking).trackingUrl ? (
                <a
                  href={(order as OrderWithTracking).trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-full items-center justify-center gap-2 text-xs font-semibold bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-3 rounded-xl transition-all shadow-lg shadow-emerald-500/20"
                  data-testid="button-track-delivery"
                >
                  <Truck size={14} />
                  Track My Delivery
                  <ExternalLink size={12} />
                </a>
              ) : isCustomer ? (
                <div className="text-xs text-muted-foreground text-center py-3">
                  Tracking link will appear here once dispatched.
                </div>
              ) : null}

              {/* Staff: show current link if set */}
              {canEditStatus && (order as OrderWithTracking).trackingUrl && (
                <a
                  href={(order as OrderWithTracking).trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  <ExternalLink size={11} />
                  Preview tracking link
                </a>
              )}
            </div>
          </div>

          {/* Payment */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-border/40 flex items-center gap-2">
              <CreditCard size={14} className="text-muted-foreground" />
              <h2 className="text-sm font-semibold uppercase tracking-wider">Payment</h2>
            </div>
            <div className="px-5 py-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Status</span>
                <span className={`text-xs font-semibold uppercase px-2.5 py-1 rounded-full border ${
                  order.paymentStatus === OrderPaymentStatus.paid
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                    : "bg-muted/30 text-muted-foreground border-border/50"
                }`} data-testid="badge-payment-status">
                  {order.paymentStatus}
                </span>
              </div>

              {order.paymentStatus === OrderPaymentStatus.unpaid && (
                <div className="space-y-3">
                  {/* Card via Stripe */}
                  <Button
                    className="w-full rounded-xl font-semibold text-xs h-10"
                    onClick={handlePay}
                    disabled={tokenizeMutation.isPending || confirmMutation.isPending}
                    data-testid="button-pay"
                  >
                    <CreditCard size={14} className="mr-2" />
                    {tokenizeMutation.isPending || confirmMutation.isPending ? "Processing..." : "Pay with Card"}
                  </Button>

                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-border/40" />
                    </div>
                    <div className="relative flex justify-center">
                      <span className="px-2 bg-card text-[10px] text-muted-foreground uppercase tracking-widest">or send directly</span>
                    </div>
                  </div>

                  {/* PayPal */}
                  <a
                    href={`https://www.paypal.com/paypalme/LuciferCruz/${order.total.toFixed(2)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 w-full text-xs font-semibold border border-[#003087]/40 text-[#009cde] bg-[#003087]/10 hover:bg-[#003087]/20 px-4 py-2.5 rounded-xl transition-all"
                    data-testid="button-paypal"
                  >
                    <ExternalLink size={12} />
                    PayPal · ${order.total.toFixed(2)}
                  </a>

                  {/* Venmo */}
                  <a
                    href={`venmo://paycharge?txn=pay&recipients=LuciferCruz&amount=${order.total.toFixed(2)}&note=Order%20%23${order.id}`}
                    className="flex items-center justify-center gap-2 w-full text-xs font-semibold border border-[#3D95CE]/40 text-[#3D95CE] bg-[#3D95CE]/10 hover:bg-[#3D95CE]/20 px-4 py-2.5 rounded-xl transition-all"
                    data-testid="button-venmo"
                  >
                    <ExternalLink size={12} />
                    Venmo · ${order.total.toFixed(2)}
                  </a>

                  {/* CashApp */}
                  <a
                    href={`https://cash.app/$LuciferCruz/${order.total.toFixed(2)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 w-full text-xs font-semibold border border-emerald-500/40 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 px-4 py-2.5 rounded-xl transition-all"
                    data-testid="button-cashapp"
                  >
                    <ExternalLink size={12} />
                    Cash App · ${order.total.toFixed(2)}
                  </a>
                </div>
              )}

              {order.paymentToken && order.paymentStatus === OrderPaymentStatus.paid && (
                <div>
                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest mb-1.5">Reference</div>
                  <div className="font-mono text-xs truncate bg-muted/20 p-2.5 rounded-lg border border-border/40" title={order.paymentToken}>
                    {order.paymentToken}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
