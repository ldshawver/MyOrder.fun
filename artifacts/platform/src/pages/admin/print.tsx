import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function statusColor(s: string) {
  if (s === "printed") return "bg-green-500/10 text-green-400 border-green-500/30";
  if (s === "failed") return "bg-red-500/10 text-red-400 border-red-500/30";
  if (s === "sending" || s === "retrying") return "bg-yellow-500/10 text-yellow-400 border-yellow-500/30";
  return "bg-muted/30 text-muted-foreground border-border/30";
}

type Printer = {
  id: number; name: string; role: string; bridgeUrl: string;
  bridgePrinterName?: string; isActive: boolean; copies: number; paperWidth: string;
};
type PrintJob = {
  id: number; orderId?: number; printerId?: number; jobType: string;
  status: string; retryCount: number; errorMessage?: string; createdAt: string;
};

function PrinterForm({ printer, onSave, onClose }: {
  printer?: Printer; onSave: (data: Partial<Printer>) => void; onClose: () => void;
}) {
  const [form, setForm] = useState({
    name: printer?.name ?? "",
    role: printer?.role ?? "kitchen",
    bridgeUrl: printer?.bridgeUrl ?? "",
    bridgePrinterName: printer?.bridgePrinterName ?? "",
    copies: printer?.copies ?? 1,
    paperWidth: printer?.paperWidth ?? "80mm",
    isActive: printer?.isActive ?? true,
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Name</Label>
          <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Kitchen Printer" />
        </div>
        <div className="space-y-1">
          <Label>Role</Label>
          <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["kitchen", "receipt", "expo", "label", "bar"].map(r => (
                <SelectItem key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 col-span-2">
          <Label>Bridge URL</Label>
          <Input value={form.bridgeUrl} onChange={e => setForm(f => ({ ...f, bridgeUrl: e.target.value }))} placeholder="http://192.168.1.10:3100" />
        </div>
        <div className="space-y-1">
          <Label>Printer Name on Bridge</Label>
          <Input value={form.bridgePrinterName} onChange={e => setForm(f => ({ ...f, bridgePrinterName: e.target.value }))} placeholder="PL70e" />
        </div>
        <div className="space-y-1">
          <Label>Copies</Label>
          <Input type="number" min={1} max={5} value={form.copies} onChange={e => setForm(f => ({ ...f, copies: parseInt(e.target.value) || 1 }))} />
        </div>
        <div className="space-y-1">
          <Label>Paper Width</Label>
          <Select value={form.paperWidth} onValueChange={v => setForm(f => ({ ...f, paperWidth: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="58mm">58mm</SelectItem>
              <SelectItem value="80mm">80mm</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 pt-5">
          <Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} />
          <Label>Active</Label>
        </div>
      </div>
      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => { onSave(form); onClose(); }}>Save Printer</Button>
      </div>
    </div>
  );
}

export default function AdminPrint() {
  const qc = useQueryClient();
  const [jobFilter, setJobFilter] = useState("all");
  const [printerDialog, setPrinterDialog] = useState<Printer | null | "new">(null);

  const { data: printersData, isLoading: printersLoading } = useQuery({
    queryKey: ["print-printers"],
    queryFn: () => apiFetch("/api/print/printers"),
  });
  const { data: jobsData, isLoading: jobsLoading } = useQuery({
    queryKey: ["print-jobs", jobFilter],
    queryFn: () => apiFetch(`/api/print/jobs${jobFilter !== "all" ? `?status=${jobFilter}` : ""}`),
    refetchInterval: 10_000,
  });
  const { data: healthData } = useQuery({
    queryKey: ["print-health"],
    queryFn: () => apiFetch("/api/print/health"),
    refetchInterval: 30_000,
  });
  const { data: settingsData } = useQuery({
    queryKey: ["print-settings"],
    queryFn: () => apiFetch("/api/print/settings"),
  });

  const createPrinter = useMutation({
    mutationFn: (data: Partial<Printer>) => apiFetch("/api/print/printers", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["print-printers"] }),
  });
  const updatePrinter = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Printer> }) =>
      apiFetch(`/api/print/printers/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["print-printers"] }),
  });
  const deletePrinter = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/print/printers/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["print-printers"] }),
  });
  const testPrinter = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/print/printers/${id}/test`, { method: "POST" }),
  });
  const retryJob = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/print/jobs/${id}/retry`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["print-jobs"] }),
  });
  const reprintJob = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/print/jobs/${id}/reprint`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["print-jobs"] }),
  });
  const updateSettings = useMutation({
    mutationFn: (data: object) => apiFetch("/api/print/settings", { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["print-settings"] }),
  });

  const printers: Printer[] = printersData?.printers ?? [];
  const jobs: PrintJob[] = jobsData?.jobs ?? [];
  const health: { id: number; name: string; online: boolean }[] = healthData?.printers ?? [];
  const settings = settingsData?.settings;

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <div className="border-b border-border/50 pb-6 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Print Management</h1>
          <p className="text-muted-foreground">Manage thermal printers, print jobs, and auto-print settings.</p>
        </div>
        <Dialog open={printerDialog === "new"} onOpenChange={o => setPrinterDialog(o ? "new" : null)}>
          <DialogTrigger asChild>
            <Button>+ Add Printer</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add Printer</DialogTitle></DialogHeader>
            <PrinterForm onSave={data => createPrinter.mutate(data)} onClose={() => setPrinterDialog(null)} />
          </DialogContent>
        </Dialog>
      </div>

      {/* Settings */}
      {settings && (
        <div className="bg-card border border-border/50 rounded-sm p-4 flex items-center gap-8">
          <div className="flex items-center gap-3">
            <Switch
              checked={settings.autoPrintOrders}
              onCheckedChange={v => updateSettings.mutate({ autoPrintOrders: v })}
            />
            <div>
              <div className="text-sm font-medium">Auto-print on order</div>
              <div className="text-xs text-muted-foreground">Send to kitchen/receipt printer when order is placed</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={settings.autoPrintReceipts}
              onCheckedChange={v => updateSettings.mutate({ autoPrintReceipts: v })}
            />
            <div>
              <div className="text-sm font-medium">Auto-print receipts</div>
              <div className="text-xs text-muted-foreground">Send customer receipt to receipt printer</div>
            </div>
          </div>
        </div>
      )}

      {/* Printers */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Printers</h2>
        <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/10">
              <TableRow className="border-border/50">
                <TableHead className="font-semibold text-xs uppercase tracking-wider">Name</TableHead>
                <TableHead className="font-semibold text-xs uppercase tracking-wider">Role</TableHead>
                <TableHead className="font-semibold text-xs uppercase tracking-wider">Bridge URL</TableHead>
                <TableHead className="font-semibold text-xs uppercase tracking-wider">Status</TableHead>
                <TableHead className="font-semibold text-xs uppercase tracking-wider">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {printersLoading ? (
                <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground text-xs uppercase tracking-widest">Loading...</TableCell></TableRow>
              ) : printers.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground text-xs">No printers configured. Add one above.</TableCell></TableRow>
              ) : printers.map(p => {
                const h = health.find(x => x.id === p.id);
                return (
                  <TableRow key={p.id} className="border-border/30 hover:bg-muted/20">
                    <TableCell className="font-medium text-sm">{p.name}</TableCell>
                    <TableCell><Badge variant="outline" className="uppercase text-xs">{p.role}</Badge></TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{p.bridgeUrl}</TableCell>
                    <TableCell>
                      {!p.isActive
                        ? <Badge variant="outline" className="text-xs text-muted-foreground">Disabled</Badge>
                        : h
                          ? <Badge variant="outline" className={`text-xs ${h.online ? "text-green-400 border-green-500/30" : "text-red-400 border-red-500/30"}`}>{h.online ? "Online" : "Offline"}</Badge>
                          : <Badge variant="outline" className="text-xs text-muted-foreground">Unknown</Badge>
                      }
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => testPrinter.mutate(p.id)}>Test</Button>
                        <Dialog open={printerDialog === p} onOpenChange={o => setPrinterDialog(o ? p : null)}>
                          <DialogTrigger asChild>
                            <Button size="sm" variant="outline">Edit</Button>
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader><DialogTitle>Edit Printer</DialogTitle></DialogHeader>
                            <PrinterForm printer={p} onSave={data => updatePrinter.mutate({ id: p.id, data })} onClose={() => setPrinterDialog(null)} />
                          </DialogContent>
                        </Dialog>
                        <Button size="sm" variant="destructive" onClick={() => { if (confirm("Delete this printer?")) deletePrinter.mutate(p.id); }}>Delete</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Print Jobs */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Print Jobs</h2>
          <Select value={jobFilter} onValueChange={setJobFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Jobs</SelectItem>
              <SelectItem value="queued">Queued</SelectItem>
              <SelectItem value="sending">Sending</SelectItem>
              <SelectItem value="printed">Printed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="retrying">Retrying</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/10">
              <TableRow className="border-border/50">
                <TableHead className="font-semibold text-xs uppercase tracking-wider">ID</TableHead>
                <TableHead className="font-semibold text-xs uppercase tracking-wider">Order</TableHead>
                <TableHead className="font-semibold text-xs uppercase tracking-wider">Type</TableHead>
                <TableHead className="font-semibold text-xs uppercase tracking-wider">Status</TableHead>
                <TableHead className="font-semibold text-xs uppercase tracking-wider">Retries</TableHead>
                <TableHead className="font-semibold text-xs uppercase tracking-wider">Time</TableHead>
                <TableHead className="font-semibold text-xs uppercase tracking-wider">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobsLoading ? (
                <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground text-xs uppercase tracking-widest">Loading...</TableCell></TableRow>
              ) : jobs.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground text-xs">No print jobs found.</TableCell></TableRow>
              ) : jobs.map(j => (
                <TableRow key={j.id} className="border-border/30 hover:bg-muted/20">
                  <TableCell className="font-mono text-xs">{j.id}</TableCell>
                  <TableCell className="font-mono text-xs">{j.orderId ?? "—"}</TableCell>
                  <TableCell className="text-xs capitalize">{j.jobType.replace("_", " ")}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs ${statusColor(j.status)}`}>{j.status}</Badge>
                    {j.errorMessage && <div className="text-xs text-red-400 mt-1 max-w-xs truncate" title={j.errorMessage}>{j.errorMessage}</div>}
                  </TableCell>
                  <TableCell className="text-xs text-center">{j.retryCount}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(j.createdAt).toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      {(j.status === "failed" || j.status === "retrying") && (
                        <Button size="sm" variant="outline" onClick={() => retryJob.mutate(j.id)}>Retry</Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => reprintJob.mutate(j.id)}>Reprint</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
