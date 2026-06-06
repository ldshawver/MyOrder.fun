import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, CheckCircle2, X } from "lucide-react";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { useOrderEvents, type OrderEvent } from "@/hooks/useOrderEvents";

type Pending = {
  orderId: number;
  customerName: string;
  total: number;
  itemCount: number;
  assignedCsrUserId: number | null;
  routedAt: string;
};

const SOUND_PREF_KEY = "csr.alertSoundEnabled";

/**
 * Animated alert banner shown to the active CSR when a new order is routed
 * to them (or to the General Account fallback). Server-side SSE scoping
 * already restricts which events arrive here, so client-side filtering is
 * a defence-in-depth check, not the security boundary.
 *
 * Includes an opt-in audible cue (persisted per browser) and a manual
 * sound-toggle in the banner itself.
 */
export function CsrAlertBanner({ currentUserId, onAccepted }: { currentUserId: number; onAccepted?: (orderId: number) => void }) {
  const { getToken } = useAuth();
  const [queue, setQueue] = useState<Pending[]>([]);
  const [accepting, setAccepting] = useState<number | null>(null);
  const [soundOn, setSoundOn] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SOUND_PREF_KEY) === "1";
  });
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SOUND_PREF_KEY, soundOn ? "1" : "0");
  }, [soundOn]);

  const playChime = () => {
    if (!soundOn || typeof window === "undefined") return;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      audioCtxRef.current = audioCtxRef.current ?? new Ctor();
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "sine"; osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      osc.start(); osc.stop(ctx.currentTime + 0.5);
    } catch { /* ignore audio failures */ }
  };

  useOrderEvents((ev: OrderEvent) => {
    if (ev.type === "order.assigned") {
      if (ev.assignedCsrUserId === null || ev.assignedCsrUserId === currentUserId) {
        setQueue(q => [
          {
            orderId: ev.orderId,
            customerName: ev.customerName,
            total: ev.total,
            itemCount: ev.itemCount,
            assignedCsrUserId: ev.assignedCsrUserId,
            routedAt: ev.routedAt,
          },
          ...q.filter(p => p.orderId !== ev.orderId),
        ]);
        playChime();
      }
    }
    if (ev.type === "order.updated" && (ev.reason === "accepted" || ev.reason === "reassigned" || ev.reason === "claimed_from_queue")) {
      setQueue(q => q.filter(p => p.orderId !== ev.orderId));
    }
  });

  const accept = async (orderId: number) => {
    setAccepting(orderId);
    try {
      const token = await getToken();
      const r = await fetch(`/api/orders/${orderId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        setQueue(q => q.filter(p => p.orderId !== orderId));
        onAccepted?.(orderId);
      }
    } finally { setAccepting(null); }
  };

  const dismiss = (orderId: number) => setQueue(q => q.filter(p => p.orderId !== orderId));

  if (queue.length === 0) {
    // Always render the sound-toggle so CSRs can opt in BEFORE the first
    // alert arrives (browsers won't autoplay audio without prior gesture).
    return (
      <div className="flex justify-end">
        <button
          onClick={() => setSoundOn(s => !s)}
          className="text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5"
          data-testid="button-toggle-csr-sound"
          aria-pressed={soundOn}
        >
          {soundOn ? <Bell size={12} /> : <BellOff size={12} />}
          alert sound: {soundOn ? "on" : "off"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="csr-alert-banner">
      <div className="flex justify-end">
        <button
          onClick={() => setSoundOn(s => !s)}
          className="text-[11px] uppercase tracking-widest text-amber-300/80 hover:text-amber-200 inline-flex items-center gap-1.5"
          data-testid="button-toggle-csr-sound"
          aria-pressed={soundOn}
        >
          {soundOn ? <Bell size={12} /> : <BellOff size={12} />}
          alert sound: {soundOn ? "on" : "off"}
        </button>
      </div>
      {queue.map((p, idx) => (
        <div
          key={p.orderId}
          className="relative overflow-hidden rounded-2xl border border-amber-500/50 bg-gradient-to-r from-amber-500/15 via-amber-500/10 to-orange-500/10 px-5 py-4 flex items-center gap-4 shadow-lg shadow-amber-500/10"
          style={{ animation: idx === 0
            ? `csrAlertPulse 1.6s ease-in-out infinite alternate, csrAlertShake 1.4s cubic-bezier(.36,.07,.19,.97) 0s infinite both`
            : `csrAlertPulse 1.6s ease-in-out infinite alternate` }}
          data-testid={`csr-alert-${p.orderId}`}
        >
          {idx === 0 && (
            <span className="absolute inset-y-0 left-0 w-1 bg-amber-400 animate-pulse" />
          )}
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
            <Bell size={18} className="text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-amber-300">
              New order routed to you · #{p.orderId}
              {p.assignedCsrUserId === null && <span className="ml-2 text-[10px] uppercase tracking-widest text-amber-400/80">general queue</span>}
            </div>
            <div className="text-xs text-amber-200/80 truncate">
              {p.customerName || "Customer"} · {p.itemCount} item{p.itemCount === 1 ? "" : "s"} · ${p.total.toFixed(2)}
            </div>
          </div>
          <Button
            size="sm"
            disabled={accepting === p.orderId}
            onClick={() => accept(p.orderId)}
            className="bg-amber-500 hover:bg-amber-400 text-black font-bold rounded-xl"
            data-testid={`button-accept-${p.orderId}`}
          >
            <CheckCircle2 size={14} className="mr-1.5" />
            {accepting === p.orderId ? "Accepting..." : "Accept Order"}
          </Button>
          <button
            onClick={() => dismiss(p.orderId)}
            className="text-amber-300/60 hover:text-amber-300 p-1"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <style>{`@keyframes csrAlertPulse {
        0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.45); }
        100% { box-shadow: 0 0 24px 6px rgba(245, 158, 11, 0); }
      }
      @keyframes csrAlertShake {
        0%, 100% { transform: translateX(0); }
        15% { transform: translateX(-6px) rotate(-0.6deg); }
        30% { transform: translateX(6px) rotate(0.6deg); }
        45% { transform: translateX(-4px); }
        60% { transform: translateX(4px); }
        75% { transform: translateX(-2px); }
      }`}</style>
    </div>
  );
}
