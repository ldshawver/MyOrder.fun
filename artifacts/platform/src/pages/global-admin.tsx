import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useGetAdminStats, useListOnboardingRequests } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { ShieldAlert, Zap, AlertTriangle, X } from "lucide-react";

function EmergencyKillSwitch() {
  const { getToken } = useAuth();
  const [step, setStep] = useState<"idle" | "confirm" | "loading" | "done">("idle");
  const [result, setResult] = useState<{ ordersDeleted: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePurge = async () => {
    setStep("loading");
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ confirm: "PURGE_ALL_SESSIONS" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Purge failed");
      setResult(data);
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("confirm");
    }
  };

  if (step === "done") {
    return (
      <div className="glass-card rounded-2xl p-6 border border-emerald-500/30 bg-emerald-500/5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center">
            <ShieldAlert size={18} className="text-emerald-400" />
          </div>
          <div>
            <div className="text-sm font-bold text-emerald-400">Kill Switch Executed</div>
            <div className="text-xs text-muted-foreground">{result?.ordersDeleted ?? 0} active orders purged.</div>
          </div>
        </div>
        <Button variant="ghost" size="sm" className="text-xs rounded-xl" onClick={() => { setStep("idle"); setResult(null); }}>
          Dismiss
        </Button>
      </div>
    );
  }

  return (
    <div className={`glass-card rounded-2xl p-6 border ${step === "confirm" ? "border-red-500/40 bg-red-500/5" : "border-border/40"}`}>
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
          <Zap size={20} className="text-red-400" />
        </div>
        <div className="flex-1">
          <div className="font-bold text-sm mb-1 text-red-400">Emergency Kill Switch</div>
          <div className="text-xs text-muted-foreground mb-4 leading-relaxed">
            Immediately purges all active orders, sessions, and tracking data.
            All connected users will see cleared state within 20 seconds.
            This action is <strong>irreversible</strong> and logged.
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5 mb-4 flex items-center gap-2">
              <AlertTriangle size={13} />
              {error}
            </div>
          )}

          {step === "idle" && (
            <Button
              variant="outline"
              size="sm"
              className="border-red-500/40 text-red-400 hover:bg-red-500/10 hover:border-red-500/60 rounded-xl text-xs font-semibold"
              onClick={() => setStep("confirm")}
              data-testid="button-kill-switch"
            >
              <Zap size={13} className="mr-1.5" />
              Activate Kill Switch
            </Button>
          )}

          {step === "confirm" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-red-400">
                <AlertTriangle size={14} />
                Are you absolutely sure? This cannot be undone.
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="bg-red-500 hover:bg-red-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-red-500/25"
                  onClick={handlePurge}
                  data-testid="button-confirm-purge"
                >
                  Confirm — Purge Everything
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-xl text-xs"
                  onClick={() => { setStep("idle"); setError(null); }}
                  data-testid="button-cancel-purge"
                >
                  <X size={13} className="mr-1" /> Cancel
                </Button>
              </div>
            </div>
          )}

          {step === "loading" && (
            <div className="text-xs text-muted-foreground animate-pulse">Executing purge sequence...</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function GlobalAdmin() {
  const { data: stats, isLoading: isStatsLoading } = useGetAdminStats({ query: { queryKey: ["getAdminStats"] } });
  const { data: requests, isLoading: isReqLoading } = useListOnboardingRequests(
    { status: "submitted", limit: 5 },
    { query: { queryKey: ["listOnboardingRequests", "submitted"] } }
  );

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-title">
          Platform Admin
        </h1>
        <p className="text-sm text-muted-foreground mt-1" data-testid="text-subtitle">
          Global oversight, tenant management, and emergency controls.
        </p>
      </div>

      {/* Stats */}
      {isStatsLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 animate-pulse">
          {[...Array(5)].map((_, i) => <div key={i} className="h-24 bg-muted/20 rounded-2xl" />)}
        </div>
      ) : stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[
            { label: "Tenants", value: stats.totalTenants },
            { label: "Active", value: stats.activeTenants },
            { label: "Pending", value: stats.pendingOnboardingRequests, highlight: true },
            { label: "GMV", value: `$${stats.totalRevenue.toLocaleString()}` },
            { label: "Orders", value: stats.totalOrders.toLocaleString() },
          ].map(({ label, value, highlight }) => (
            <div
              key={label}
              className={`glass-card rounded-2xl p-4 ${highlight ? "border-primary/25 bg-primary/5" : ""}`}
              data-testid={`card-metric-${label.toLowerCase()}`}
            >
              <div className={`text-[10px] font-semibold uppercase tracking-widest mb-2 ${highlight ? "text-primary" : "text-muted-foreground"}`}>
                {label}
              </div>
              <div className={`text-2xl font-bold ${highlight ? "text-primary" : ""}`}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Emergency Kill Switch */}
      <div>
        <div className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-widest mb-3">Emergency Controls</div>
        <EmergencyKillSwitch />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pending Applications */}
        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border/40 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider">Pending Applications</h2>
            <Link href="/global-admin/onboarding" className="text-xs text-primary hover:underline" data-testid="link-view-all-onboarding">
              View All →
            </Link>
          </div>
          {isReqLoading ? (
            <div className="text-center py-12 text-muted-foreground text-xs animate-pulse">Loading...</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30">
                  <TableHead className="text-xs text-muted-foreground">Company</TableHead>
                  <TableHead className="text-xs text-muted-foreground">Contact</TableHead>
                  <TableHead className="text-xs text-muted-foreground">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests?.requests?.map(req => (
                  <TableRow key={req.id} className="border-border/30">
                    <TableCell className="font-medium text-sm">{req.companyName}</TableCell>
                    <TableCell className="text-sm">{req.contactName}</TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">{new Date(req.createdAt).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))}
                {(!requests?.requests || requests.requests.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center py-12 text-muted-foreground text-xs">
                      No pending applications
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </div>

        {/* Recent Activity */}
        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border/40 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider">Recent Activity</h2>
            <Link href="/global-admin/audit" className="text-xs text-primary hover:underline" data-testid="link-view-all-audit">
              View Log →
            </Link>
          </div>
          <div className="divide-y divide-border/30 overflow-y-auto max-h-[360px]">
            {stats?.recentActivity?.map(log => (
              <div key={log.id} className="flex justify-between items-start px-5 py-4 hover:bg-white/[0.02] transition-colors">
                <div>
                  <div className={`font-semibold text-xs mb-0.5 ${log.action === "EMERGENCY_PURGE" ? "text-red-400" : ""}`}>
                    {log.action}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono">{log.actorEmail} · {log.resourceType}</div>
                </div>
                <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest text-right shrink-0 ml-4">
                  {new Date(log.createdAt).toLocaleString()}
                </div>
              </div>
            ))}
            {(!stats?.recentActivity || stats.recentActivity.length === 0) && (
              <div className="text-center py-12 text-muted-foreground text-xs">No recent activity</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
