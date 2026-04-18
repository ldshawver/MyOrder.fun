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

type OrderWithTracking = Order & { trackingUrl?: string };

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

      {/* ── Customer waiting view: Hourglass ───────────────────────── */}
      {isCustomer && isPendingOrProcessing && (
        <div className="glass-card rounded-2xl p-8 border border-primary/20 bg-primary/3 flex flex-col items-center text-center">
          <AnimatedHourglass
            size={200}
            message={order.status === "pending"
              ? "Your order is in the queue..."
              : "Our lab team is working on your order..."
            }
          />
          <p className="text-sm text-muted-foreground mt-4 max-w-sm">
            {STATUS_MESSAGES[order.status]}
            {" "}You'll receive a push notification the moment it's ready.
          </p>
        </div>
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
              {STATUS_MESSAGES[order.status]}
            </div>
          </div>
        </div>
      )}

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
