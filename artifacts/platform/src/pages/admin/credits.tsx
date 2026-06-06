import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type CreditUser = {
  id: number;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  status?: string | null;
  balance: number;
  lastCreditAt?: string | null;
};

export default function AdminCredits() {
  const { getToken } = useAuth();
  const [users, setUsers] = useState<CreditUser[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const token = await getToken();
    const res = await fetch("/api/admin/credits", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Failed to load credits");
    setUsers(Array.isArray(data.users) ? data.users : []);
    setLoading(false);
  }, [getToken]);

  useEffect(() => { load().catch((err) => { setMessage(err.message); setLoading(false); }); }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(user => `${user.firstName ?? ""} ${user.lastName ?? ""} ${user.email ?? ""}`.toLowerCase().includes(q));
  }, [query, users]);

  async function grantCredit() {
    if (!selectedId) return;
    setSaving(true);
    setMessage(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/credits", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ userId: selectedId, amount: Number(amount), reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to save credit");
      setAmount("");
      setReason("");
      setMessage("Credit saved.");
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save credit");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="border-b border-border/50 pb-5">
        <h1 className="text-3xl font-bold tracking-tight">Credit Management</h1>
        <p className="text-sm text-muted-foreground mt-1">Grant or debit customer store credit before checkout.</p>
      </div>

      <Card className="rounded-sm border-border/50">
        <CardHeader className="bg-muted/10 border-b border-border/50">
          <CardTitle className="text-sm uppercase tracking-wider">Adjust Credit</CardTitle>
        </CardHeader>
        <CardContent className="pt-5 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">User</Label>
            <select
              className="mt-1 h-9 w-full rounded-sm bg-background border border-input px-3 text-sm"
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select user</option>
              {users.map(user => (
                <option key={user.id} value={user.id}>
                  {[user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || `User ${user.id}`} (${Number(user.balance).toFixed(2)})
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Amount</Label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="25.00 or -10.00" className="mt-1 rounded-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Supervisor credit" className="mt-1 rounded-sm" />
          </div>
          <Button onClick={grantCredit} disabled={!selectedId || !amount || saving} className="rounded-sm">
            {saving ? "Saving..." : "Save Credit"}
          </Button>
          {message && <div className="md:col-span-4 text-sm text-muted-foreground">{message}</div>}
        </CardContent>
      </Card>

      <Card className="rounded-sm border-border/50">
        <CardHeader className="bg-muted/10 border-b border-border/50">
          <CardTitle className="text-sm uppercase tracking-wider">Users</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter users" className="rounded-sm mb-4 max-w-sm" />
          {loading ? <div className="text-sm text-muted-foreground">Loading...</div> : (
            <div className="divide-y divide-border/40">
              {filtered.map(user => (
                <div key={user.id} className="py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">{[user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || `User ${user.id}`}</div>
                    <div className="text-xs text-muted-foreground">{user.email} · {user.status ?? "pending"}</div>
                  </div>
                  <div className="font-mono font-semibold">${Number(user.balance).toFixed(2)}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
