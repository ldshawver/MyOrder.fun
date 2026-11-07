import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, ExternalLink, MapPin, Truck, UserRound } from "lucide-react";
import { getGetOrderQueryKey } from "@workspace/api-client-react";
import AnimatedHourglass from "@/components/AnimatedHourglass";
import { useOrderEvents } from "@/hooks/useOrderEvents";
import { customerTracker } from "@/lib/orderTracker";

type StagePayload = {
  preparerName: string | null;
  pickupInstructions: string | null;
  specialNotes: string | null;
  acceptedAt: string | null;
  estimatedReadyAt: string | null;
  readyAt: string | null;
  pickupAt: string | null;
  deliveryMethod: string | null;
  deliveryLabel: string | null;
  departedAt: string | null;
};

export type StageOrder = {
  id: number;
  status: string;
  fulfillmentStatus?: string | null;
  createdAt: string | Date;
  updatedAt?: string | Date | null;
  estimatedReadyAt?: string | Date | null;
  readyAt?: string | Date | null;
  serverNow?: string | Date | null;
  deliveryMethod?: string | null;
  deliveryFee?: number | null;
  notes?: string | null;
  trackingUrl?: string | null;
  deliveryQuote?: { dropoffEta?: string | null; duration?: number | null } | null;
};

function asIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function clock(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function withoutGeneralQueueNote(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const kept = value.split(/\n+/).map(line => line.trim()).filter(line => line && !/general\s*que/i.test(line));
  return kept.length ? kept.join("\n") : null;
}

export function CustomerOrderStage({ order }: { order: StageOrder }) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [elapsed, setElapsed] = useState(0);
  const [stage, setStage] = useState<StagePayload | null>(null);

  useEffect(() => {
    const start = performance.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(performance.now() - start), 1000);
    return () => clearInterval(timer);
  }, [order.serverNow]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const token = await getToken();
      const response = await fetch(`/api/orders/${order.id}/stage`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (response.ok && !cancelled) {
        const data = await response.json() as Partial<StagePayload>;
        if (data && typeof data === "object" && "preparerName" in data) setStage(data as StagePayload);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [getToken, order.id, order.updatedAt]);

  useOrderEvents((event) => {
    if (event.orderId !== order.id) return;
    if (event.type === "order.updated" || event.type === "order.ready" || event.type === "order.assigned") {
      queryClient.invalidateQueries({ queryKey: getGetOrderQueryKey(order.id) });
    }
  });

  const serverNow = Date.parse(asIso(order.serverNow) ?? "");
  const tracker = customerTracker({
    createdAt: asIso(order.createdAt) ?? new Date().toISOString(),
    estimatedReadyAt: stage?.estimatedReadyAt ?? asIso(order.estimatedReadyAt),
    readyAt: stage?.readyAt ?? asIso(order.readyAt),
    fulfillmentStatus: order.fulfillmentStatus,
    status: order.status,
    deliveryMethod: stage?.deliveryMethod ?? order.deliveryMethod,
  }, Number.isFinite(serverNow) ? serverNow + elapsed : Date.now());

  const personal = (stage?.deliveryMethod ?? order.deliveryMethod) === "csr_delivery";
  const uber = (stage?.deliveryMethod ?? order.deliveryMethod) === "uber_direct";
  const delivery = personal || uber;
  const state = (order.fulfillmentStatus ?? order.status ?? "submitted").toLowerCase();
  const accepted = Boolean(stage?.acceptedAt);
  const ready = tracker.phase === "ready" || state === "ready";
  const finished = tracker.phase === "completed" || state === "completed" || state === "delivered";
  const preparing = accepted || ["in_progress", "preparing", "processing", "accepted"].includes(state);
  const preparer = stage?.preparerName || (accepted || preparing ? "Your specialist" : "Waiting for a specialist");
  const steps = [
    { id: "received", label: "Received", detail: "Your order is in." },
    { id: "started", label: "Started", detail: accepted || preparing ? `${preparer} is on it.` : "A specialist will start it." },
    { id: "preparing", label: "Preparing", detail: tracker.label },
    { id: "ready", label: personal ? "Heading out" : uber ? "Driver" : "Ready", detail: personal ? "Your specialist brings it to you." : uber ? "Driver updates land here." : "Ready for pickup." },
    { id: "finish", label: finished ? "Complete" : delivery ? "On the way" : "Pickup", detail: finished ? "This order is finished." : delivery ? "On the way to you." : "Come pick it up." },
  ];
  const current = finished ? 4 : ready ? 3 : preparing ? 2 : accepted ? 1 : 0;
  const remaining = tracker.remainingMs;
  const mins = Math.floor((remaining ?? 0) / 60000);
  const secs = Math.floor(((remaining ?? 0) % 60000) / 1000);
  const readyClock = clock(stage?.readyAt ?? asIso(order.readyAt)) ?? clock(stage?.estimatedReadyAt ?? asIso(order.estimatedReadyAt));
  const pickupAtDate = stage?.pickupAt ? new Date(stage.pickupAt) : null;
  const pickupClock = pickupAtDate && !Number.isNaN(pickupAtDate.getTime())
    ? pickupAtDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : null;
  const specialNotes = withoutGeneralQueueNote(stage ? stage.specialNotes : order.notes);
  const pickupInstructions = withoutGeneralQueueNote(stage?.pickupInstructions);

  return (
    <section className="stage-aurora relative overflow-hidden rounded-3xl border border-primary/30 p-5 sm:p-8" data-testid="customer-hourglass-panel">
      <style>{`
        .stage-aurora { background: linear-gradient(120deg, rgba(37,99,235,0.16), rgba(15,23,42,0.2), rgba(16,185,129,0.12), rgba(99,102,241,0.18)); background-size: 280% 280%; animation: stage-aurora 16s ease infinite; }
        @keyframes stage-aurora { 0% { background-position: 0% 40%; } 50% { background-position: 100% 60%; } 100% { background-position: 0% 40%; } }
        @media (prefers-reduced-motion: reduce) { .stage-aurora { animation: none; } }
      `}</style>
      <div className="relative grid gap-8 lg:grid-cols-[280px_1fr]">
        <div className="flex flex-col items-center text-center">
          <AnimatedHourglass size={230} message={tracker.label} progress={tracker.phase === "placed" && tracker.progress === 0 ? undefined : tracker.progress} />
          <div className="mt-2 w-full" data-testid="hourglass-countdown">
            <div className={`font-mono text-4xl font-bold tracking-tight ${tracker.phase === "overdue" ? "text-amber-300" : "text-primary"}`}>
              {finished ? "Done" : ready ? "Ready" : remaining == null ? "15:00" : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`}
            </div>
            <p className="mt-1 text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
              {finished ? "order complete" : ready ? "ready now" : remaining == null ? "starts when your order is accepted" : tracker.phase === "overdue" ? "finishing up" : "until ready"}
            </p>
          </div>
          <p className="mt-3 max-w-xs text-sm text-foreground/90" data-testid="customer-stage-message" role="status" aria-live="polite">{tracker.label}</p>
        </div>
        <div className="space-y-4">
          <ol className="grid gap-2 sm:grid-cols-5" data-testid="customer-order-steps">
            {steps.map((step, index) => {
              const done = index < current || finished;
              const active = index === current && !finished;
              return (
                <li key={step.id} className={`rounded-2xl border px-3 py-3 ${done ? "border-emerald-400/40 bg-emerald-500/10" : active ? "border-primary/50 bg-primary/15" : "border-border/40 bg-background/40"}`}>
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    {done ? <CheckCircle2 size={13} className="text-emerald-300" /> : <span className={`inline-block h-2 w-2 rounded-full ${active ? "animate-pulse bg-primary" : "bg-muted-foreground/40"}`} />}
                    {step.label}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{step.detail}</p>
                </li>
              );
            })}
          </ol>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-border/40 bg-background/70 p-4">
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-primary"><UserRound size={13} /> Preparing</div>
              <div className="mt-1 text-lg font-semibold" data-testid="customer-preparer">{preparer}</div>
              <p className="text-xs text-muted-foreground">{accepted || preparing ? "Accepted and in progress." : "The countdown starts when this order is accepted."}</p>
            </div>
            <div className="rounded-2xl border border-border/40 bg-background/70 p-4">
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-primary"><Clock size={13} /> Ready</div>
              <div className="mt-1 text-lg font-semibold" data-testid="customer-ready-time">{ready ? "Ready now" : readyClock ? `Around ${readyClock}` : "15 minutes after it starts"}</div>
              {pickupClock && !delivery && <p className="text-xs text-muted-foreground">Scheduled pickup {pickupClock}</p>}
            </div>
            {pickupInstructions && (
              <div className="rounded-2xl border border-border/40 bg-background/70 p-4 sm:col-span-2" data-testid="customer-pickup-instructions">
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-primary"><MapPin size={13} /> Pickup</div>
                <p className="mt-1 text-sm whitespace-pre-wrap">{pickupInstructions}</p>
              </div>
            )}
            {specialNotes && (
              <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 sm:col-span-2" data-testid="customer-special-notes">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-200">Special notes</div>
                <p className="mt-1 text-sm whitespace-pre-wrap">{specialNotes}</p>
              </div>
            )}
          </div>
          {delivery && (
            <div className="rounded-2xl border border-primary/30 bg-background/75 p-4" data-testid={personal ? "customer-personal-delivery" : "customer-uber-info"}>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary"><Truck size={14} /> Delivery</div>
              <div className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
                <div><div className="text-[10px] uppercase text-muted-foreground">Status</div><div data-testid="customer-courier-status">{stage?.deliveryLabel ?? (personal ? "Your specialist is handling this delivery." : "Driver updates appear here.")}</div></div>
                <div><div className="text-[10px] uppercase text-muted-foreground">Fee</div><div>{order.deliveryFee != null ? `$${order.deliveryFee.toFixed(2)}` : "Quoted at checkout"}</div></div>
                <div><div className="text-[10px] uppercase text-muted-foreground">Arrival</div><div>{clock(order.deliveryQuote?.dropoffEta) ?? (order.deliveryQuote?.duration ? `${order.deliveryQuote.duration} min` : "Waiting for dispatch")}</div></div>
              </div>
              {order.trackingUrl && (
                <a href={order.trackingUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline">
                  Track the driver <ExternalLink size={12} />
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
