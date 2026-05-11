import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Loader2, RefreshCw, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type PendingShift = {
  shiftId: number;
  techName: string;
  techEmail: string;
  clockedInAt: string | null;
  clockedOutAt: string | null;
  cashBankStart: number;
  cashBankEndReported: number;
  totalRevenue: number;
};

const TIP_OPTIONS = [15, 16, 17, 18] as const;

export default function AdminCloseouts() {
  const { getToken } = useAuth();
  const [shifts, setShifts] = useState<PendingShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tipById, setTipById] = useState<Record<number, number>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/shifts/pending-supervisor", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Load failed (HTTP ${res.status}): ${txt.slice(0, 200)}`);
      }
      const data = await res.json();
      const list: PendingShift[] = data.pendingShifts ?? [];
      setShifts(list);
      setTipById(prev => {
        const next = { ...prev };
        for (const s of list) {
          if (next[s.shiftId] === undefined) next[s.shiftId] = 17;
        }
        return next;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { load(); }, [load]);

  async function approve(shiftId: number) {
    setBusyId(shiftId);
    setError(null);
    setResultMessage(null);
    try {
      const tipPercent = tipById[shiftId] ?? 17;
      const token = await getToken();
      const res = await fetch(`/api/shifts/${shiftId}/supervisor-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tipPercent }),
      });
      const text = await res.text();
      let body: unknown = {};
      try { body = JSON.parse(text); } catch { /* leave as text */ }
      if (!res.ok) {
        const errMsg = (body as { error?: string }).error ?? text.slice(0, 200);
        throw new Error(`Approve failed (HTTP ${res.status}): ${errMsg}`);
      }
      setShifts(prev => prev.filter(s => s.shiftId !== shiftId));
      const checkout = (body as { checkout?: { finalTip?: number; depositAmount?: number } }).checkout ?? {};
      setResultMessage(`Shift #${shiftId} finalized — tip $${(checkout.finalTip ?? 0).toFixed(2)}, deposit $${(checkout.depositAmount ?? 0).toFixed(2)}.`);
      setTimeout(() => setResultMessage(null), 6000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-5" data-testid="page-admin-closeouts">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Shift Closeouts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Shifts waiting on supervisor checkout. Pick a tip percent and approve to finalize.
          </p>
        </div>
        <Button onClick={load} variant="outline" size="sm" className="gap-1.5 rounded-xl" data-testid="button-closeouts-reload">
          <RefreshCw size={12} /> Reload
        </Button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 p-3 text-sm" data-testid="text-closeouts-error">{error}</div>
      )}

      {resultMessage && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 text-green-400 p-3 text-sm flex items-center gap-2">
          <CheckCircle2 size={14} /> {resultMessage}
        </div>
      )}

      {shifts.length === 0 ? (
        <div className="rounded-xl border border-border/40 bg-card/30 p-8 text-center text-sm text-muted-foreground" data-testid="text-closeouts-empty">
          No shifts are waiting on supervisor closeout.
        </div>
      ) : (
        <div className="space-y-3">
          {shifts.map(s => {
            const cashDelta = s.cashBankEndReported - s.cashBankStart;
            return (
              <div key={s.shiftId} className="rounded-xl border border-border/40 bg-card/30 p-4" data-testid={`row-closeout-${s.shiftId}`}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="space-y-1">
                    <div className="text-sm font-semibold">Shift #{s.shiftId} — {s.techName || s.techEmail || "Unknown"}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.clockedInAt ? new Date(s.clockedInAt).toLocaleString() : "—"} → {s.clockedOutAt ? new Date(s.clockedOutAt).toLocaleString() : "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">{s.techEmail}</div>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <Stat label="Revenue" value={`$${s.totalRevenue.toFixed(2)}`} />
                    <Stat label="Cash start" value={`$${s.cashBankStart.toFixed(2)}`} />
                    <Stat label="Cash end" value={`$${s.cashBankEndReported.toFixed(2)}`} delta={cashDelta} />
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground mr-1">Tip %:</span>
                    {TIP_OPTIONS.map(opt => (
                      <button
                        key={opt}
                        onClick={() => setTipById(prev => ({ ...prev, [s.shiftId]: opt }))}
                        data-testid={`button-tip-${s.shiftId}-${opt}`}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                          tipById[s.shiftId] === opt
                            ? "border-primary/50 bg-primary/15 text-primary"
                            : "border-border/40 bg-background/60 text-muted-foreground hover:text-foreground"
                        }`}
                      >{opt}%</button>
                    ))}
                  </div>
                  <Button
                    onClick={() => approve(s.shiftId)}
                    disabled={busyId === s.shiftId}
                    size="sm"
                    className="gap-1.5 rounded-xl"
                    data-testid={`button-approve-${s.shiftId}`}
                  >
                    {busyId === s.shiftId ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                    Approve & finalize
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, delta }: { label: string; value: string; delta?: number }) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5 text-center min-w-[90px]">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="font-mono font-semibold">{value}</div>
      {delta !== undefined && (
        <div className={`text-[10px] font-mono ${delta >= 0 ? "text-green-400" : "text-red-400"}`}>
          {delta >= 0 ? "+" : ""}{delta.toFixed(2)}
        </div>
      )}
    </div>
  );
}
