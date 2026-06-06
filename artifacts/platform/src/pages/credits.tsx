import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BadgeDollarSign } from "lucide-react";

type CreditEntry = {
  id: number;
  amount: number;
  reason?: string | null;
  source: string;
  createdAt: string;
};

export default function Credits() {
  const { getToken } = useAuth();
  const [balance, setBalance] = useState(0);
  const [entries, setEntries] = useState<CreditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getToken().then(async token => {
      const res = await fetch("/api/credits/me", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to load credit");
      if (!cancelled) {
        setBalance(Number(data.balance ?? 0));
        setEntries(Array.isArray(data.entries) ? data.entries : []);
      }
    }).catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load credit");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [getToken]);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="border-b border-border/50 pb-5">
        <h1 className="text-3xl font-bold tracking-tight">Credit</h1>
        <p className="text-sm text-muted-foreground mt-1">Store credit added by a supervisor or platform admin.</p>
      </div>

      <Card className="rounded-sm border-border/50">
        <CardHeader className="bg-muted/10 border-b border-border/50 flex flex-row items-center gap-3">
          <BadgeDollarSign size={18} className="text-primary" />
          <CardTitle className="text-sm uppercase tracking-wider">Available Credit</CardTitle>
        </CardHeader>
        <CardContent className="pt-6">
          {loading ? (
            <div className="text-sm text-muted-foreground animate-pulse">Loading...</div>
          ) : error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : (
            <div className="text-4xl font-bold">${balance.toFixed(2)}</div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-sm border-border/50">
        <CardHeader className="bg-muted/10 border-b border-border/50">
          <CardTitle className="text-sm uppercase tracking-wider">Credit History</CardTitle>
        </CardHeader>
        <CardContent className="pt-4 divide-y divide-border/40">
          {entries.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6">No credit activity yet.</div>
          ) : entries.map(entry => (
            <div key={entry.id} className="py-3 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium">{entry.reason || entry.source}</div>
                <div className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</div>
              </div>
              <div className={`font-mono font-semibold ${entry.amount >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                {entry.amount >= 0 ? "+" : ""}${entry.amount.toFixed(2)}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
