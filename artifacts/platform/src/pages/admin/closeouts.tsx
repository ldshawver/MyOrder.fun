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
  inventoryAccountability: {
    total: string;
    blockers: Array<{ code: string; message: string; itemName: string }>;
    lines: Array<{ shiftInventoryItemId: number; itemName: string; expectedQuantity: string; countedQuantity: string; missingQuantity: string; retailPrice: string; unitReplacementValue: string; lineTotal: string }>;
  };
};
type ActiveShift = { shiftId: number; techId: number; techName: string; techEmail: string; boxAssignmentId?: string | null; clockedInAt: string; cashBankStart: number };

const TIP_OPTIONS = [15, 16, 17, 18] as const;

export default function AdminCloseouts() {
  const { getToken } = useAuth();
  const [shifts, setShifts] = useState<PendingShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tipById, setTipById] = useState<Record<number, number>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [activeShifts, setActiveShifts] = useState<ActiveShift[]>([]);
  const [targetById, setTargetById] = useState<Record<number, number>>({});
  const [cashEndById, setCashEndById] = useState<Record<number, string>>({});
  const [reasonById, setReasonById] = useState<Record<number, string>>({});
  const [confirmedById, setConfirmedById] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const [res, activeRes] = await Promise.all([
        fetch("/api/shifts/pending-supervisor", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/shifts/active-techs", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (!res.ok || !activeRes.ok) throw new Error(`Load failed (HTTP ${res.ok ? activeRes.status : res.status})`);
      const data = await res.json();
      const activeData = await activeRes.json();
      const list: PendingShift[] = data.pendingShifts ?? [];
      setShifts(list);
      const active: ActiveShift[] = activeData.activeTechs ?? [];
      setActiveShifts(active);
      setCashEndById(prev => Object.fromEntries(active.map(s => [s.shiftId, prev[s.shiftId] ?? String(s.cashBankStart)])));
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

  async function reassign(shiftId: number) {
    const targetShiftId = targetById[shiftId];
    if (!targetShiftId) return;
    setBusyId(shiftId); setError(null); setResultMessage(null);
    try {
      const token = await getToken();
      const res = await fetch(`/api/shifts/${shiftId}/reassign`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ targetShiftId, reason: "Supervisor reassigned orders before CSR shift termination" }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Reassignment failed");
      setResultMessage(`Reassigned ${(body.movedOrderIds ?? []).length} order(s).`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Reassignment failed"); }
    finally { setBusyId(null); }
  }

  async function terminate(shiftId: number) {
    setBusyId(shiftId); setError(null); setResultMessage(null);
    try {
      const token = await getToken();
      const res = await fetch(`/api/shifts/${shiftId}/terminate`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ cashBankEnd: Number(cashEndById[shiftId]), reason: "Supervisor terminated stale CSR shift" }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Termination failed");
      setResultMessage(`Shift #${shiftId} terminated and queued for audited closeout.`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Termination failed"); }
    finally { setBusyId(null); }
  }

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
        body: JSON.stringify({
          tipPercent,
          supervisorReason: reasonById[shiftId]?.trim() || undefined,
          confirmInventoryAccountability: confirmedById[shiftId] ?? false,
          remainderPolicy: "carry_forward_to_future_shift_payout",
        }),
      });
      const text = await res.text();
      let body: unknown = {};
      try { body = JSON.parse(text); } catch { /* leave as text */ }
      if (!res.ok) {
        const errMsg = (body as { error?: string }).error ?? text.slice(0, 200);
        throw new Error(`Approve failed (HTTP ${res.status}): ${errMsg}`);
      }
      setShifts(prev => prev.filter(s => s.shiftId !== shiftId));
      const checkout = (body as { checkout?: { finalCsrPayout?: string; depositAmount?: number; inventoryAccountability?: { totalRemainder?: string } } }).checkout ?? {};
      setResultMessage(`Shift #${shiftId} finalized — contractor payout $${checkout.finalCsrPayout ?? "0.00"}, cash deposit $${(checkout.depositAmount ?? 0).toFixed(2)}, carried inventory balance $${checkout.inventoryAccountability?.totalRemainder ?? "0.00"}.`);
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

      <section className="rounded-xl border border-border/40 bg-card/30 p-4 space-y-3" data-testid="active-shift-controls">
        <div>
          <h2 className="font-semibold">Active CSR shift controls</h2>
          <p className="text-xs text-muted-foreground mt-1">Reassign open orders before terminating a stale shift. Termination preserves the shift for supervisor closeout.</p>
        </div>
        {activeShifts.length === 0 ? <p className="text-sm text-muted-foreground">No active CSR shifts.</p> : activeShifts.map(shift => {
          const targets = activeShifts.filter(candidate => candidate.shiftId !== shift.shiftId);
          return <div key={shift.shiftId} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/30 p-3" data-testid={`active-shift-${shift.shiftId}`}>
            <span className="text-sm font-medium min-w-44">{shift.techName || shift.techEmail} · #{shift.shiftId}</span>
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={targetById[shift.shiftId] ?? ""} onChange={e => setTargetById(prev => ({ ...prev, [shift.shiftId]: Number(e.target.value) }))} aria-label={`Reassign shift ${shift.shiftId}`}>
              <option value="">Reassign orders to…</option>{targets.map(target => <option key={target.shiftId} value={target.shiftId}>{target.techName} · shift #{target.shiftId}</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={!targetById[shift.shiftId] || busyId === shift.shiftId} onClick={() => void reassign(shift.shiftId)}>Reassign orders</Button>
            <input className="h-9 w-24 rounded-md border bg-background px-2 text-sm" inputMode="decimal" value={cashEndById[shift.shiftId] ?? ""} onChange={e => setCashEndById(prev => ({ ...prev, [shift.shiftId]: e.target.value }))} aria-label={`Cash end for shift ${shift.shiftId}`} />
            <Button size="sm" variant="destructive" disabled={busyId === shift.shiftId} onClick={() => void terminate(shift.shiftId)}>Terminate shift</Button>
          </div>;
        })}
      </section>

      {shifts.length === 0 ? (
        <div className="rounded-xl border border-border/40 bg-card/30 p-8 text-center text-sm text-muted-foreground" data-testid="text-closeouts-empty">
          No shifts are waiting on supervisor closeout.
        </div>
      ) : (
        <div className="space-y-3">
          {shifts.map(s => {
            const cashDelta = s.cashBankEndReported - s.cashBankStart;
            const hasShortage = s.inventoryAccountability.lines.length > 0;
            const hasBlockers = s.inventoryAccountability.blockers.length > 0;
            const reasonReady = (reasonById[s.shiftId]?.trim().length ?? 0) >= 10;
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

                <div className="mt-4 rounded-lg border border-border/40 bg-background/40 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold">Inventory accountability</div>
                      <div className="text-[11px] text-muted-foreground">Shortages use the exact item/variant retail price at closeout, less 20%. Overages are not charged.</div>
                    </div>
                    <div className="text-sm font-mono font-semibold">${s.inventoryAccountability.total}</div>
                  </div>
                  {s.inventoryAccountability.lines.map(line => <div key={line.shiftInventoryItemId} className="grid grid-cols-2 gap-1 text-xs md:grid-cols-6">
                    <span className="md:col-span-2 font-medium">{line.itemName}</span><span>Expected {line.expectedQuantity}</span><span>Counted {line.countedQuantity}</span><span>Missing {line.missingQuantity}</span><span>80% unit ${line.unitReplacementValue} · line ${line.lineTotal}</span>
                  </div>)}
                  {s.inventoryAccountability.blockers.map(blocker => <div key={`${blocker.code}:${blocker.itemName}`} className="text-xs text-red-400"><b>{blocker.itemName}:</b> {blocker.message}</div>)}
                  {hasShortage && <>
                    <label className="block text-xs">Supervisor reason
                      <textarea className="mt-1 min-h-16 w-full rounded-md border bg-background px-2 py-1.5" value={reasonById[s.shiftId] ?? ""} onChange={event => setReasonById(prev => ({ ...prev, [s.shiftId]: event.target.value }))} placeholder="Explain the reviewed inventory shortage (minimum 10 characters)" />
                    </label>
                    <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={confirmedById[s.shiftId] ?? false} onChange={event => setConfirmedById(prev => ({ ...prev, [s.shiftId]: event.target.checked }))} /><span>I reviewed the counts and exact retail-price snapshots. Apply no more than the payable amount now and carry any remainder to a future shift payout as an audited contractor inventory-accountability adjustment.</span></label>
                  </>}
                </div>

                <div className="mt-3 rounded-lg border border-border/40 bg-background/40 p-3 text-xs">
                  <div className="font-semibold">Cash reconciliation (separate from payout)</div>
                  <div className="mt-1 text-muted-foreground">Opening cash ${s.cashBankStart.toFixed(2)} · Counted cash ${s.cashBankEndReported.toFixed(2)}. Inventory offsets are not cash received and do not increase the deposit.</div>
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
                    disabled={busyId === s.shiftId || hasBlockers || (hasShortage && (!reasonReady || !confirmedById[s.shiftId]))}
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
