import { useState } from "react";
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
  useGetCurrentUser
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Lock, MessageSquare, CreditCard, ShieldAlert } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export default function OrderDetail() {
  const params = useParams();
  const id = parseInt(params.id || "0", 10);
  const queryClient = useQueryClient();

  const [noteContent, setNoteContent] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [isEncrypted, setIsEncrypted] = useState(false);

  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const canEditStatus = user?.role === "global_admin" || user?.role === "tenant_admin" || user?.role === "staff";

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

  if (isOrderLoading) return <div className="p-8">Loading order architecture...</div>;
  if (!order) return <div className="p-8 text-destructive">Order not found.</div>;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 pb-6 border-b border-border/50">
        <Link href="/orders" className="text-muted-foreground hover:text-foreground transition-colors shrink-0" data-testid="link-back">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-3xl font-bold tracking-tight" data-testid="text-order-id">Order #{order.id}</h1>
            <Badge variant="outline" className="font-mono uppercase text-[10px] tracking-widest">{order.status}</Badge>
          </div>
          <p className="text-muted-foreground text-sm font-mono">
            {new Date(order.createdAt).toLocaleString()}
          </p>
        </div>
        {canEditStatus && (
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-xs font-mono font-medium text-muted-foreground uppercase">Update Status</span>
            <Select value={order.status} onValueChange={(v) => handleStatusChange(v as OrderStatus)}>
              <SelectTrigger className="w-[160px] rounded-sm bg-background border-border" data-testid="select-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                {Object.values(OrderStatus).map(status => (
                  <SelectItem key={status} value={status} className="font-mono text-xs uppercase">{status}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <Card className="rounded-sm border-border/50 shadow-sm">
            <CardHeader className="bg-muted/10 border-b border-border/50 pb-3">
              <CardTitle className="text-sm font-semibold uppercase tracking-wider">Manifest</CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-0 divide-y divide-border/30">
                {order.items.map(item => (
                  <div key={item.id} className="flex items-center justify-between py-4 first:pt-0 last:pb-0">
                    <div>
                      <div className="font-medium text-sm">{item.catalogItemName}</div>
                      <div className="text-xs text-muted-foreground font-mono mt-1">${item.unitPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })} x {item.quantity}</div>
                    </div>
                    <div className="font-medium text-sm font-mono">
                      ${item.totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="pt-6 mt-6 border-t border-border/50 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground font-mono uppercase text-xs">Subtotal</span>
                  <span className="font-mono">${order.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                {order.tax !== undefined && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground font-mono uppercase text-xs">Tax</span>
                    <span className="font-mono">${order.tax.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-lg pt-3 border-t border-border/20">
                  <span className="font-mono uppercase text-xs tracking-wider mt-1">Total</span>
                  <span className="tracking-tight">${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-sm border-border/50 shadow-sm">
            <CardHeader className="bg-muted/10 border-b border-border/50 pb-3">
              <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2">
                <MessageSquare size={14} /> Audit Trail & Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              <div className="space-y-4">
                {isNotesLoading ? (
                  <div className="text-sm text-muted-foreground font-mono">Loading telemetry...</div>
                ) : notesRes?.notes?.length === 0 ? (
                  <div className="text-sm text-muted-foreground font-mono uppercase tracking-widest text-center py-4 border border-dashed border-border/50 rounded-sm">No annotations.</div>
                ) : (
                  notesRes?.notes?.map(note => (
                    <div key={note.id} className={`p-4 rounded-sm border ${note.isInternal ? 'bg-secondary/10 border-secondary/30' : 'bg-card border-border/50'}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs uppercase tracking-wider">{note.authorName || "System"}</span>
                          {note.isInternal && <Badge variant="secondary" className="text-[9px] uppercase tracking-widest px-1.5 py-0">Internal</Badge>}
                          {note.isEncrypted && <Lock size={12} className="text-muted-foreground" />}
                        </div>
                        <span className="text-[10px] font-mono text-muted-foreground">
                          {new Date(note.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap leading-relaxed">{note.content}</p>
                    </div>
                  ))
                )}
              </div>

              <div className="pt-6 border-t border-border/50 space-y-4">
                <Textarea 
                  placeholder="Add a new annotation..." 
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  className="resize-none rounded-sm bg-background border-border/50 focus:border-primary"
                  data-testid="input-note"
                />
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-6">
                    {canEditStatus && (
                      <div className="flex items-center space-x-2">
                        <Switch id="internal" checked={isInternal} onCheckedChange={setIsInternal} data-testid="switch-internal" />
                        <Label htmlFor="internal" className="text-xs font-mono uppercase tracking-wider cursor-pointer">Internal</Label>
                      </div>
                    )}
                    <div className="flex items-center space-x-2">
                      <Switch id="encrypted" checked={isEncrypted} onCheckedChange={setIsEncrypted} data-testid="switch-encrypted" />
                      <Label htmlFor="encrypted" className="text-xs font-mono uppercase tracking-wider cursor-pointer flex items-center gap-1.5">
                        <Lock size={12} /> Encrypt
                      </Label>
                    </div>
                  </div>
                  <Button onClick={handleAddNote} disabled={!noteContent.trim() || addNoteMutation.isPending} className="rounded-sm font-semibold uppercase tracking-wider text-xs h-9" data-testid="button-add-note">
                    {addNoteMutation.isPending ? "Committing..." : "Commit Note"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-8">
          <Card className="rounded-sm border-border/50 shadow-sm">
            <CardHeader className="bg-muted/10 border-b border-border/50 pb-3">
              <CardTitle className="text-sm font-semibold uppercase tracking-wider">Entity Details</CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-5">
              <div>
                <div className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest">Name</div>
                <div className="font-medium text-sm">{order.customerName || "N/A"}</div>
              </div>
              <div>
                <div className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest">Email</div>
                <div className="font-medium text-sm">{order.customerEmail || "N/A"}</div>
              </div>
              <div>
                <div className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest">Destination Address</div>
                <div className="text-sm whitespace-pre-wrap leading-relaxed">{order.shippingAddress || "N/A"}</div>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-sm border-border/50 shadow-sm">
            <CardHeader className="bg-muted/10 border-b border-border/50 pb-3">
              <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2">
                <CreditCard size={14} /> Settlement
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-mono font-medium text-muted-foreground uppercase tracking-widest">Status</div>
                <Badge variant={order.paymentStatus === OrderPaymentStatus.paid ? "default" : "outline"} className="uppercase text-[10px] tracking-widest px-2 py-0.5 rounded-sm" data-testid="badge-payment-status">
                  {order.paymentStatus}
                </Badge>
              </div>
              {order.paymentToken && (
                <div>
                  <div className="text-[10px] font-mono font-medium text-muted-foreground mb-1 uppercase tracking-widest">Reference Hash</div>
                  <div className="font-mono text-xs truncate bg-muted/30 p-2 rounded-sm border border-border/50" title={order.paymentToken}>{order.paymentToken}</div>
                </div>
              )}
              
              {order.paymentStatus === OrderPaymentStatus.unpaid && (
                <div className="pt-4 border-t border-border/50">
                  <Button 
                    className="w-full rounded-sm font-semibold uppercase tracking-wider text-xs" 
                    onClick={handlePay}
                    disabled={tokenizeMutation.isPending || confirmMutation.isPending}
                    data-testid="button-pay"
                  >
                    {tokenizeMutation.isPending || confirmMutation.isPending ? "Processing..." : "Authorize Payment"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
