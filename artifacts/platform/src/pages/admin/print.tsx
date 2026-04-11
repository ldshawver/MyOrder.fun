import { useState, useCallback, createContext, useContext, Fragment, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Eye, EyeOff, CheckCircle2, XCircle, Loader2, Printer, Tag } from "lucide-react";

// ── Auth-aware fetch context ───────────────────────────────────────────────────
// All API calls in this file use the Clerk Bearer token (Authorization header).

type ApiFetchFn = (path: string, init?: RequestInit) => Promise<unknown>;

const ApiFetchCtx = createContext<ApiFetchFn | null>(null);

function useApiFetch(): ApiFetchFn {
  const fn = useContext(ApiFetchCtx);
  if (!fn) throw new Error("Must be inside PrintProvider");
  return fn;
}

function PrintProvider({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const apiFetch = useCallback(async (path: string, init?: RequestInit) => {
    const token = await getToken();
    const res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(text || `HTTP ${res.status}`);
    }
    return res.json();
  }, [getToken]);

  return <ApiFetchCtx.Provider value={apiFetch}>{children}</ApiFetchCtx.Provider>;
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Printer = {
  id: number; name: string; role: string; connectionType: string;
  directIp?: string; directPort?: number;
  bridgeUrl?: string; bridgePrinterName?: string; apiKey?: string;
  isActive: boolean; copies: number; paperWidth: string; timeoutMs: number;
  online?: boolean;
};
type Profile = {
  id: number; userId: number; email: string; firstName?: string; lastName?: string; role: string;
  receiptPrinterId?: number; labelPrinterId?: number; fallbackReceiptPrinterId?: number;
  isDefault: boolean;
};
type PrintJob = {
  id: number; orderId?: number; printerId?: number; operatorUserId?: number;
  jobType: string; status: string; retryCount: number; printedVia?: string;
  errorMessage?: string; createdAt: string; printedAt?: string;
};
type PrintTemplate = {
  id: number; name: string; jobType: string; paperWidth: string; paperHeight: string;
  templateJson: unknown[]; isActive: boolean; isDefault: boolean;
};
type RoutingStatus = {
  operator: { userId: number; email: string; firstName?: string; lastName?: string; role: string; source: string } | null;
  receiptPrinter: (Printer & { online: boolean | null }) | null;
  piFallback: (Printer & { online: boolean | null }) | null;
  labelPrinter: (Printer & { online: boolean | null }) | null;
};
type TestResult = { loading: boolean; ok?: boolean; error?: string; jobId?: number };

// ── Helpers ───────────────────────────────────────────────────────────────────
function statusColor(s: string) {
  if (s === "printed") return "bg-green-500/10 text-green-400 border-green-500/30";
  if (s === "failed") return "bg-red-500/10 text-red-400 border-red-500/30";
  if (s === "sending" || s === "retrying") return "bg-yellow-500/10 text-yellow-400 border-yellow-500/30";
  return "bg-muted/30 text-muted-foreground border-border/30";
}
function OnlineDot({ online }: { online: boolean | null | undefined }) {
  if (online === null || online === undefined)
    return <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/40 mr-1.5" />;
  return <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${online ? "bg-green-400" : "bg-red-400"}`} />;
}
function connLabel(t: string) {
  return { ethernet_direct: "Ethernet Direct", mac_bridge: "Mac Bridge", pi_bridge: "Pi Bridge", bridge: "Bridge" }[t] ?? t;
}

// ── ROUTING TAB ───────────────────────────────────────────────────────────────
function RoutingTab() {
  const apiFetch = useApiFetch();
  const { data, isLoading, refetch } = useQuery<RoutingStatus>({
    queryKey: ["print-routing"],
    queryFn: () => apiFetch("/api/print/routing") as Promise<RoutingStatus>,
    refetchInterval: 30_000,
  });

  if (isLoading) return <div className="text-muted-foreground text-sm py-12 text-center">Loading routing status…</div>;

  const op = data?.operator;
  const r = data?.receiptPrinter;
  const pi = data?.piFallback;
  const l = data?.labelPrinter;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Live Routing Status</h2>
        <Button variant="outline" size="sm" onClick={() => refetch()}>Refresh</Button>
      </div>

      <div className="bg-card border border-border/50 rounded-sm p-5">
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Active Operator</div>
        {op ? (
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-sm font-bold">
              {(op.firstName?.[0] ?? op.email[0]).toUpperCase()}
            </div>
            <div>
              <div className="font-medium">{op.firstName} {op.lastName}</div>
              <div className="text-sm text-muted-foreground">{op.email}</div>
              <div className="text-xs mt-0.5">
                <Badge variant="outline" className="text-xs mr-2">{op.role.replace("_", " ")}</Badge>
                <span className="text-muted-foreground">{op.source === "shift" ? "Active shift" : "Admin fallback"}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">No active operator — no one is clocked in and no admin found.</div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card border border-border/50 rounded-sm p-4 space-y-2">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Receipt Printer</div>
          {r ? (
            <>
              <div className="flex items-center gap-1.5 font-medium text-sm"><OnlineDot online={r.online} />{r.name}</div>
              <div className="text-xs text-muted-foreground">{connLabel(r.connectionType)}</div>
              {r.bridgeUrl && <div className="font-mono text-xs text-muted-foreground truncate">{r.bridgeUrl}</div>}
              {r.bridgePrinterName && <div className="text-xs text-muted-foreground">Queue: {r.bridgePrinterName}</div>}
              <Badge variant="outline" className={`text-xs ${r.online ? "text-green-400 border-green-500/30" : "text-red-400 border-red-500/30"}`}>
                {r.online ? "Reachable" : "Unreachable"}
              </Badge>
            </>
          ) : <div className="text-muted-foreground text-xs">Not configured</div>}
        </div>

        <div className="bg-card border border-border/50 rounded-sm p-4 space-y-2">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Pi Fallback (Receipt)</div>
          {pi ? (
            <>
              <div className="flex items-center gap-1.5 font-medium text-sm"><OnlineDot online={pi.online} />{pi.name}</div>
              <div className="font-mono text-xs text-muted-foreground truncate">{pi.bridgeUrl}</div>
              <Badge variant="outline" className={`text-xs ${pi.online ? "text-green-400 border-green-500/30" : "text-red-400 border-red-500/30"}`}>
                {pi.online ? "Reachable" : "Unreachable"}
              </Badge>
            </>
          ) : <div className="text-muted-foreground text-xs">Not configured</div>}
        </div>

        <div className="bg-card border border-border/50 rounded-sm p-4 space-y-2">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Label Printer (Mac Bridge)</div>
          {l ? (
            <>
              <div className="flex items-center gap-1.5 font-medium text-sm"><OnlineDot online={l.online} />{l.name}</div>
              <div className="font-mono text-xs text-muted-foreground truncate">{l.bridgeUrl}</div>
              {l.bridgePrinterName && <div className="text-xs text-muted-foreground">Queue: {l.bridgePrinterName}</div>}
              <Badge variant="outline" className={`text-xs ${l.online ? "text-green-400 border-green-500/30" : "text-red-400 border-red-500/30"}`}>
                {l.online ? "Reachable" : "Unreachable"}
              </Badge>
            </>
          ) : <div className="text-muted-foreground text-xs">Not configured</div>}
        </div>
      </div>

      <div className="text-xs text-muted-foreground border-t border-border/30 pt-4">
        Probed via TCP socket (Ethernet) and /health endpoint (bridges). Auto-refreshes every 30s.
      </div>

      <BridgeDiagnosticsPanel />
    </div>
  );
}

// ── BRIDGE DIAGNOSTICS PANEL ──────────────────────────────────────────────────
type BridgeHealthResult = {
  ok: boolean; httpStatus?: number; bridgeUrl?: string;
  printerName?: string; hasApiKey?: boolean; error?: string;
  body?: { status?: string; version?: string; printers?: string[] };
};
type BridgePrintersResult = {
  ok: boolean; httpStatus?: number; bridgeUrl?: string; error?: string;
  body?: { printers?: string[] } | { queues?: string[] } | unknown;
};

function BridgeDiagnosticsPanel() {
  const apiFetch = useApiFetch();
  const [healthResult, setHealthResult] = useState<BridgeHealthResult | null>(null);
  const [printersResult, setPrintersResult] = useState<BridgePrintersResult | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [printersLoading, setPrintersLoading] = useState(false);

  const testHealth = async () => {
    setHealthLoading(true);
    setHealthResult(null);
    try {
      const r = await apiFetch("/api/print/bridge/health") as BridgeHealthResult;
      setHealthResult(r);
    } catch (e) {
      setHealthResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setHealthLoading(false);
    }
  };

  const listPrinters = async () => {
    setPrintersLoading(true);
    setPrintersResult(null);
    try {
      const r = await apiFetch("/api/print/bridge/printers") as BridgePrintersResult;
      setPrintersResult(r);
    } catch (e) {
      setPrintersResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setPrintersLoading(false);
    }
  };

  const queues: string[] = printersResult?.ok
    ? ((printersResult.body as { printers?: string[] })?.printers
      ?? (printersResult.body as { queues?: string[] })?.queues
      ?? [])
    : [];

  return (
    <div className="bg-card border border-border/50 rounded-sm p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Bridge Direct Diagnostics</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Probe bridge health and list its known printer queues without creating a print job.
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="text-xs" disabled={healthLoading} onClick={testHealth}>
            {healthLoading ? <Loader2 size={11} className="animate-spin mr-1" /> : null}
            Check Health
          </Button>
          <Button variant="outline" size="sm" className="text-xs" disabled={printersLoading} onClick={listPrinters}>
            {printersLoading ? <Loader2 size={11} className="animate-spin mr-1" /> : null}
            List Queues
          </Button>
        </div>
      </div>

      {healthResult && (
        <div className={`rounded-sm border p-3 text-xs space-y-1 ${healthResult.ok ? "bg-green-500/5 border-green-500/20" : "bg-red-500/5 border-red-500/20"}`}>
          <div className="flex items-center gap-2 font-medium">
            {healthResult.ok
              ? <CheckCircle2 size={13} className="text-green-400" />
              : <XCircle size={13} className="text-red-400" />}
            Bridge Health: {healthResult.ok ? "OK" : "FAILED"}
          </div>
          {healthResult.bridgeUrl && <div className="text-muted-foreground">URL: <span className="font-mono text-foreground">{healthResult.bridgeUrl}</span></div>}
          {healthResult.httpStatus && <div className="text-muted-foreground">HTTP Status: {healthResult.httpStatus}</div>}
          {healthResult.hasApiKey !== undefined && <div className="text-muted-foreground">API Key: {healthResult.hasApiKey ? "present" : "missing"}</div>}
          {healthResult.body?.version && <div className="text-muted-foreground">Version: {healthResult.body.version}</div>}
          {healthResult.error && <div className="text-red-400 font-mono whitespace-pre-wrap">{healthResult.error}</div>}
          {healthResult.body && !healthResult.error && (
            <details className="mt-1">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw response</summary>
              <pre className="mt-1 p-2 bg-muted/20 rounded text-[10px] overflow-auto max-h-32">{JSON.stringify(healthResult.body, null, 2)}</pre>
            </details>
          )}
        </div>
      )}

      {printersResult && (
        <div className={`rounded-sm border p-3 text-xs space-y-1 ${printersResult.ok ? "bg-blue-500/5 border-blue-500/20" : "bg-red-500/5 border-red-500/20"}`}>
          <div className="flex items-center gap-2 font-medium">
            {printersResult.ok
              ? <CheckCircle2 size={13} className="text-blue-400" />
              : <XCircle size={13} className="text-red-400" />}
            Bridge Printer Queues: {printersResult.ok ? `${queues.length} found` : "Failed"}
          </div>
          {queues.length > 0 && (
            <div className="space-y-0.5 pt-1">
              {queues.map(q => (
                <div key={q} className="font-mono text-foreground bg-muted/20 px-2 py-0.5 rounded text-[11px]">{q}</div>
              ))}
            </div>
          )}
          {printersResult.error && <div className="text-red-400 font-mono">{printersResult.error}</div>}
          {printersResult.ok && queues.length === 0 && (
            <div className="text-muted-foreground">No queues returned — check bridge /printers endpoint.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── PRINTER FORM ──────────────────────────────────────────────────────────────
function PrinterForm({ printer, onSave, onClose }: {
  printer?: Printer; onSave: (d: Record<string, unknown>) => void; onClose: () => void;
}) {
  const [form, setForm] = useState({
    name: printer?.name ?? "",
    role: printer?.role ?? "receipt",
    connectionType: printer?.connectionType ?? "bridge",
    directIp: printer?.directIp ?? "",
    directPort: printer?.directPort ?? 9100,
    bridgeUrl: printer?.bridgeUrl ?? "http://100.103.51.63:3001",
    bridgePrinterName: printer?.bridgePrinterName ?? "",
    apiKey: "",
    copies: printer?.copies ?? 1,
    paperWidth: printer?.paperWidth ?? "80mm",
    timeoutMs: printer?.timeoutMs ?? 8000,
    isActive: printer?.isActive ?? true,
  });
  const [showKey, setShowKey] = useState(false);
  const isEthernet = form.connectionType === "ethernet_direct";
  const isBridge = !isEthernet;
  const hasExistingKey = Boolean(printer?.apiKey);

  const save = () => {
    const payload: Record<string, unknown> = { ...form };
    if (!form.apiKey.trim()) delete payload.apiKey;
    onSave(payload);
    onClose();
  };

  return (
    <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Name</Label>
          <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Receipt POS80" />
        </div>
        <div className="space-y-1">
          <Label>Role</Label>
          <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {["receipt", "label", "kitchen", "expo", "bar"].map(r => (
                <SelectItem key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 col-span-2">
          <Label>Connection Type</Label>
          <Select value={form.connectionType} onValueChange={v => setForm(f => ({ ...f, connectionType: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="bridge">Mac Bridge (HTTP + API key)</SelectItem>
              <SelectItem value="mac_bridge">Mac Bridge (legacy)</SelectItem>
              <SelectItem value="pi_bridge">Raspberry Pi Bridge (HTTP)</SelectItem>
              <SelectItem value="ethernet_direct">Ethernet Direct (raw TCP)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isEthernet && <>
          <div className="space-y-1">
            <Label>Printer IP Address</Label>
            <Input value={form.directIp} onChange={e => setForm(f => ({ ...f, directIp: e.target.value }))} placeholder="192.168.68.66" />
          </div>
          <div className="space-y-1">
            <Label>Port</Label>
            <Input type="number" value={form.directPort} onChange={e => setForm(f => ({ ...f, directPort: parseInt(e.target.value) || 9100 }))} />
          </div>
        </>}

        {isBridge && <>
          <div className="space-y-1 col-span-2">
            <Label>Bridge URL</Label>
            <Input value={form.bridgeUrl} onChange={e => setForm(f => ({ ...f, bridgeUrl: e.target.value }))} placeholder="http://100.103.51.63:3001" />
            <p className="text-xs text-muted-foreground mt-1">Tailscale IP + port of the Mac running the print bridge</p>
          </div>
          <div className="space-y-1 col-span-2">
            <Label>Printer Name on Bridge</Label>
            <Input value={form.bridgePrinterName} onChange={e => setForm(f => ({ ...f, bridgePrinterName: e.target.value }))} placeholder="Reciept_POS80_Printer" />
            <p className="text-xs text-muted-foreground mt-1">Exact queue name from <span className="font-mono">lpstat -p</span> on the Mac. Case-sensitive.</p>
          </div>
          <div className="space-y-1 col-span-2">
            <Label>API Key</Label>
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                value={form.apiKey}
                onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
                placeholder={hasExistingKey ? "Leave blank to keep existing key" : "Enter PRINT_BRIDGE_API_KEY value"}
                className="pr-10"
              />
              <button type="button" onClick={() => setShowKey(s => !s)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            {hasExistingKey
              ? <p className="text-xs text-amber-400 mt-1">A key is already set. Type a new one to replace it, or leave blank to keep it.</p>
              : <p className="text-xs text-red-400 mt-1">No API key set — bridge will reject requests until one is added.</p>}
          </div>
        </>}

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
        <div className="space-y-1">
          <Label>Copies</Label>
          <Input type="number" min={1} max={5} value={form.copies} onChange={e => setForm(f => ({ ...f, copies: parseInt(e.target.value) || 1 }))} />
        </div>
        <div className="space-y-1">
          <Label>Timeout (ms)</Label>
          <Input type="number" value={form.timeoutMs} onChange={e => setForm(f => ({ ...f, timeoutMs: parseInt(e.target.value) || 8000 }))} />
        </div>
        <div className="flex items-center gap-2 pt-5">
          <Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} />
          <Label>Active</Label>
        </div>
      </div>
      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!form.name}>Save Printer</Button>
      </div>
    </div>
  );
}

// ── Test Result Banner ─────────────────────────────────────────────────────────
function TestBanner({ result, onDismiss }: { result: TestResult; onDismiss: () => void }) {
  if (result.loading) return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/20 rounded px-3 py-1.5 mt-1">
      <Loader2 size={12} className="animate-spin shrink-0" />Sending test print…
    </div>
  );
  if (result.ok) return (
    <div className="flex items-center gap-2 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded px-3 py-1.5 mt-1">
      <CheckCircle2 size={12} className="shrink-0" />Test print sent (Job #{result.jobId})
      <button onClick={onDismiss} className="ml-auto text-green-400/60 hover:text-green-400">✕</button>
    </div>
  );
  return (
    <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-1.5 mt-1 space-y-0.5">
      <div className="flex items-start gap-2">
        <XCircle size={12} className="shrink-0 mt-0.5" /><span className="font-medium">Test print failed</span>
        <button onClick={onDismiss} className="ml-auto text-red-400/60 hover:text-red-400 shrink-0">✕</button>
      </div>
      {result.error && <div className="pl-5 text-red-400/80 leading-relaxed">{result.error}</div>}
    </div>
  );
}

// ── PRINTERS SECTION ──────────────────────────────────────────────────────────
function PrintersSection({ title, icon: Icon, printers, health, testResults, onTest, onDismissTest, dialog, setDialog, onUpdate, onDelete }: {
  title: string; icon: typeof Printer;
  printers: Printer[]; health: { id: number; online: boolean }[];
  testResults: Record<number, TestResult>;
  onTest: (id: number) => void; onDismissTest: (id: number) => void;
  dialog: Printer | "new" | null; setDialog: (d: Printer | null) => void;
  onUpdate: (id: number, d: Record<string, unknown>) => void; onDelete: (id: number) => void;
}) {
  if (printers.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground px-1">
        <Icon size={12} />{title}
      </div>
      <div className="bg-card border border-border/50 rounded-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow className="border-border/50">
              <TableHead className="text-xs uppercase tracking-wider">Name</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Type</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Target / Queue</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">API Key</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Status</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {printers.map(p => {
              const h = health.find(x => x.id === p.id);
              const tr = testResults[p.id];
              const target = p.connectionType === "ethernet_direct" ? `${p.directIp}:${p.directPort ?? 9100}` : p.bridgeUrl ?? "—";
              return (
                <Fragment key={p.id}>
                  <TableRow className="border-border/30 hover:bg-muted/20">
                    <TableCell className="font-medium text-sm">{p.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{connLabel(p.connectionType)}</TableCell>
                    <TableCell className="text-xs">
                      <div className="font-mono text-muted-foreground truncate max-w-[180px]" title={target}>{target}</div>
                      {p.bridgePrinterName && <div className="text-muted-foreground/60 mt-0.5">Queue: {p.bridgePrinterName}</div>}
                    </TableCell>
                    <TableCell className="text-xs">
                      {p.apiKey ? <Badge variant="outline" className="text-xs text-green-400 border-green-500/30">Set</Badge>
                        : <Badge variant="outline" className="text-xs text-red-400 border-red-500/30">Missing</Badge>}
                    </TableCell>
                    <TableCell>
                      {!p.isActive ? <Badge variant="outline" className="text-xs text-muted-foreground">Disabled</Badge>
                        : h ? <Badge variant="outline" className={`text-xs ${h.online ? "text-green-400 border-green-500/30" : "text-red-400 border-red-500/30"}`}>{h.online ? "Online" : "Offline"}</Badge>
                          : <Badge variant="outline" className="text-xs text-muted-foreground">Unknown</Badge>}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1.5 flex-wrap">
                        <Button size="sm" variant="outline" className="text-xs h-7" disabled={tr?.loading} onClick={() => onTest(p.id)}>
                          {tr?.loading ? <Loader2 size={11} className="animate-spin mr-1" /> : null}Test Print
                        </Button>
                        <Dialog open={dialog === p} onOpenChange={o => setDialog(o ? p : null)}>
                          <DialogTrigger asChild><Button size="sm" variant="outline" className="text-xs h-7">Edit</Button></DialogTrigger>
                          <DialogContent className="max-w-lg">
                            <DialogHeader><DialogTitle>Edit Printer — {p.name}</DialogTitle></DialogHeader>
                            <PrinterForm printer={p} onSave={d => onUpdate(p.id, d)} onClose={() => setDialog(null)} />
                          </DialogContent>
                        </Dialog>
                        <Button size="sm" variant="destructive" className="text-xs h-7" onClick={() => { if (confirm(`Delete ${p.name}?`)) onDelete(p.id); }}>Del</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {tr && (
                    <TableRow className="border-border/20">
                      <TableCell colSpan={6} className="py-1 px-4">
                        <TestBanner result={tr} onDismiss={() => onDismissTest(p.id)} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ── PRINTERS TAB ──────────────────────────────────────────────────────────────
function PrintersTab() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Printer | "new" | null>(null);
  const [testResults, setTestResults] = useState<Record<number, TestResult>>({});
  const [seedApiKey, setSeedApiKey] = useState("");
  const [seedResult, setSeedResult] = useState<{ ok: boolean; results?: { action: string; name: string; role: string }[]; error?: string } | null>(null);
  const [seedLoading, setSeedLoading] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ["print-printers"], queryFn: () => apiFetch("/api/print/printers") as Promise<{ printers: Printer[] }> });
  const { data: healthData } = useQuery({ queryKey: ["print-health"], queryFn: () => apiFetch("/api/print/health") as Promise<{ printers: { id: number; online: boolean }[] }>, refetchInterval: 30_000 });

  const create = useMutation({ mutationFn: (d: Record<string, unknown>) => apiFetch("/api/print/printers", { method: "POST", body: JSON.stringify(d) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["print-printers"] }) });
  const update = useMutation({ mutationFn: ({ id, d }: { id: number; d: Record<string, unknown> }) => apiFetch(`/api/print/printers/${id}`, { method: "PATCH", body: JSON.stringify(d) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["print-printers"] }) });
  const del = useMutation({ mutationFn: (id: number) => apiFetch(`/api/print/printers/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["print-printers"] }) });
  const test = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/print/printers/${id}/test`, { method: "POST" }) as Promise<{ ok: boolean; error?: string; jobId?: number }>,
    onMutate: (id) => setTestResults(r => ({ ...r, [id]: { loading: true } })),
    onSuccess: (data, id) => { setTestResults(r => ({ ...r, [id]: { loading: false, ok: data.ok, error: data.error, jobId: data.jobId } })); qc.invalidateQueries({ queryKey: ["print-jobs"] }); },
    onError: (err: Error, id) => setTestResults(r => ({ ...r, [id]: { loading: false, ok: false, error: err.message } })),
  });

  const seedDefaults = async () => {
    setSeedLoading(true);
    setSeedResult(null);
    try {
      const r = await apiFetch("/api/print/printers/seed-defaults", {
        method: "POST",
        body: JSON.stringify({ bridgeUrl: "http://100.103.51.63:3001", apiKey: seedApiKey }),
      }) as { ok: boolean; results: { action: string; name: string; role: string }[] };
      setSeedResult(r);
      qc.invalidateQueries({ queryKey: ["print-printers"] });
    } catch (e) {
      setSeedResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSeedLoading(false);
    }
  };

  const printers: Printer[] = (data as { printers: Printer[] })?.printers ?? [];
  const health: { id: number; online: boolean }[] = (healthData as { printers: { id: number; online: boolean }[] })?.printers ?? [];

  const receiptPrinters = printers.filter(p => ["receipt", "kitchen", "expo", "bar"].includes(p.role));
  const labelPrinters = printers.filter(p => p.role === "label");
  const otherPrinters = printers.filter(p => !["receipt", "kitchen", "expo", "bar", "label"].includes(p.role));

  const sharedProps = {
    health, testResults,
    onTest: (id: number) => test.mutate(id),
    onDismissTest: (id: number) => setTestResults(r => { const n = { ...r }; delete n[id]; return n; }),
    dialog, setDialog: (d: Printer | null) => setDialog(d),
    onUpdate: (id: number, d: Record<string, unknown>) => update.mutate({ id, d }),
    onDelete: (id: number) => del.mutate(id),
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">Printers</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Bridge URL: <span className="font-mono">http://100.103.51.63:3001</span> (Tailscale)</p>
        </div>
        <Dialog open={dialog === "new"} onOpenChange={o => setDialog(o ? "new" : null)}>
          <DialogTrigger asChild><Button>+ Add Printer</Button></DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Add Printer</DialogTitle></DialogHeader>
            <PrinterForm onSave={d => create.mutate(d)} onClose={() => setDialog(null)} />
          </DialogContent>
        </Dialog>
      </div>

      {isLoading && <div className="text-muted-foreground text-sm text-center py-8">Loading printers…</div>}
      {!isLoading && printers.length === 0 && (
        <div className="bg-card border border-border/50 rounded-sm p-8 text-center text-muted-foreground text-sm">
          No printers configured yet. Click "+ Add Printer" to add your receipt and label printers.
        </div>
      )}

      <PrintersSection title="Receipt, Kitchen & Expo Printers" icon={Printer} printers={receiptPrinters} {...sharedProps} />
      <PrintersSection title="Label Printers" icon={Tag} printers={labelPrinters} {...sharedProps} />
      <PrintersSection title="Other Printers" icon={Printer} printers={otherPrinters} {...sharedProps} />

      <div className="bg-amber-500/5 border border-amber-500/20 rounded-sm p-4 space-y-3">
        <div className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Mac Bridge Configuration Reference</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="space-y-1">
            <div className="font-medium">Receipt Printer (POS80)</div>
            <div className="text-muted-foreground">Role: <span className="text-foreground">receipt</span></div>
            <div className="text-muted-foreground">Connection: <span className="text-foreground">bridge</span></div>
            <div className="text-muted-foreground">Bridge URL: <span className="font-mono text-foreground">http://100.103.51.63:3001</span></div>
            <div className="text-muted-foreground">Queue Name: <span className="font-mono text-foreground">Reciept_POS80_Printer</span></div>
            <div className="text-muted-foreground">API Key env: <span className="font-mono text-foreground">PRINT_BRIDGE_API_KEY</span></div>
          </div>
          <div className="space-y-1">
            <div className="font-medium">Label Printer (Thermal)</div>
            <div className="text-muted-foreground">Role: <span className="text-foreground">label</span></div>
            <div className="text-muted-foreground">Connection: <span className="text-foreground">bridge</span></div>
            <div className="text-muted-foreground">Bridge URL: <span className="font-mono text-foreground">http://100.103.51.63:3001</span></div>
            <div className="text-muted-foreground">Queue Name: <span className="font-mono text-foreground">Label_Themal_Printer</span></div>
            <div className="text-muted-foreground">API Key: same as receipt printer</div>
          </div>
        </div>

        <div className="border-t border-amber-500/10 pt-3 space-y-2">
          <div className="text-xs font-medium text-amber-300">Quick Setup — Load Default Printers</div>
          <div className="text-xs text-muted-foreground">Upserts both printers with correct queue names and bridge URL in one click.</div>
          <div className="flex gap-2 items-center">
            <Input
              className="h-7 text-xs font-mono max-w-xs"
              placeholder="API key (optional — leave blank to keep existing)"
              value={seedApiKey}
              onChange={e => setSeedApiKey(e.target.value)}
            />
            <Button size="sm" variant="outline" className="text-xs h-7 whitespace-nowrap" disabled={seedLoading} onClick={seedDefaults}>
              {seedLoading ? <Loader2 size={11} className="animate-spin mr-1" /> : null}
              Load Defaults
            </Button>
          </div>
          {seedResult && (
            <div className={`rounded text-xs p-2 space-y-0.5 ${seedResult.ok ? "bg-green-500/10 border border-green-500/20" : "bg-red-500/10 border border-red-500/20"}`}>
              {seedResult.ok && seedResult.results?.map(r => (
                <div key={r.name} className="flex items-center gap-2">
                  <CheckCircle2 size={11} className="text-green-400 shrink-0" />
                  <span className="font-mono">{r.name}</span>
                  <span className="text-muted-foreground">{r.action} · {r.role}</span>
                </div>
              ))}
              {!seedResult.ok && <span className="text-red-400">{seedResult.error}</span>}
            </div>
          )}
        </div>

        <div className="text-xs text-muted-foreground border-t border-amber-500/10 pt-2">
          Verify queue names with <span className="font-mono">lpstat -p</span> on the Mac — names are case-sensitive.
        </div>
      </div>
    </div>
  );
}

// ── PROFILES TAB ──────────────────────────────────────────────────────────────
function ProfileForm({ profile, printers, users, onSave, onClose }: {
  profile?: Profile; printers: Printer[];
  users: { id: number; email: string; firstName?: string; lastName?: string; role: string }[];
  onSave: (d: object) => void; onClose: () => void;
}) {
  const [form, setForm] = useState({
    userId: profile?.userId ? String(profile.userId) : "",
    receiptPrinterId: profile?.receiptPrinterId ? String(profile.receiptPrinterId) : "none",
    labelPrinterId: profile?.labelPrinterId ? String(profile.labelPrinterId) : "none",
    fallbackReceiptPrinterId: profile?.fallbackReceiptPrinterId ? String(profile.fallbackReceiptPrinterId) : "none",
    isDefault: profile?.isDefault ?? false,
  });

  const save = () => {
    onSave({
      userId: Number(form.userId),
      receiptPrinterId: form.receiptPrinterId !== "none" ? Number(form.receiptPrinterId) : null,
      labelPrinterId: form.labelPrinterId !== "none" ? Number(form.labelPrinterId) : null,
      fallbackReceiptPrinterId: form.fallbackReceiptPrinterId !== "none" ? Number(form.fallbackReceiptPrinterId) : null,
      isDefault: form.isDefault,
    });
    onClose();
  };

  return (
    <div className="space-y-4">
      {!profile && (
        <div className="space-y-1">
          <Label>Operator</Label>
          <Select value={form.userId} onValueChange={v => setForm(f => ({ ...f, userId: v }))}>
            <SelectTrigger><SelectValue placeholder="Select operator…" /></SelectTrigger>
            <SelectContent>
              {users.map(u => <SelectItem key={u.id} value={String(u.id)}>{u.email} ({u.role})</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="space-y-1">
        <Label>Receipt Printer</Label>
        <Select value={form.receiptPrinterId} onValueChange={v => setForm(f => ({ ...f, receiptPrinterId: v }))}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— None —</SelectItem>
            {printers.filter(p => p.isActive && ["receipt", "kitchen", "expo", "bar"].includes(p.role)).map(p => (
              <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>Label Printer</Label>
        <Select value={form.labelPrinterId} onValueChange={v => setForm(f => ({ ...f, labelPrinterId: v }))}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— None —</SelectItem>
            {printers.filter(p => p.isActive && p.role === "label").map(p => (
              <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>Pi Fallback Printer</Label>
        <Select value={form.fallbackReceiptPrinterId} onValueChange={v => setForm(f => ({ ...f, fallbackReceiptPrinterId: v }))}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— None —</SelectItem>
            {printers.filter(p => p.isActive).map(p => (
              <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={form.isDefault} onCheckedChange={v => setForm(f => ({ ...f, isDefault: v }))} />
        <Label>Default profile (used when no active shift)</Label>
      </div>
      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!form.userId}>Save Profile</Button>
      </div>
    </div>
  );
}

function ProfilesTab() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Profile | "new" | null>(null);

  const { data: profilesData } = useQuery({ queryKey: ["print-profiles"], queryFn: () => apiFetch("/api/print/profiles") as Promise<{ profiles: Profile[] }> });
  const { data: printersData } = useQuery({ queryKey: ["print-printers"], queryFn: () => apiFetch("/api/print/printers") as Promise<{ printers: Printer[] }> });
  const { data: usersData } = useQuery({ queryKey: ["print-users"], queryFn: () => apiFetch("/api/print/users") as Promise<{ users: { id: number; email: string; firstName?: string; lastName?: string; role: string }[] }> });

  const save = useMutation({
    mutationFn: (d: object) => apiFetch("/api/print/profiles", { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["print-profiles"] }); qc.invalidateQueries({ queryKey: ["print-routing"] }); },
  });
  const del = useMutation({ mutationFn: (id: number) => apiFetch(`/api/print/profiles/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["print-profiles"] }) });

  const profiles: Profile[] = (profilesData as { profiles: Profile[] })?.profiles ?? [];
  const printers: Printer[] = (printersData as { printers: Printer[] })?.printers ?? [];
  const users: { id: number; email: string; firstName?: string; lastName?: string; role: string }[] = (usersData as { users: { id: number; email: string; firstName?: string; lastName?: string; role: string }[] })?.users ?? [];
  const printerName = (id?: number) => id ? (printers.find(p => p.id === id)?.name ?? `#${id}`) : "—";

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">Operator Print Profiles</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Map each operator to their receipt, label, and fallback printers.</p>
        </div>
        <Dialog open={dialog === "new"} onOpenChange={o => setDialog(o ? "new" : null)}>
          <DialogTrigger asChild><Button>+ Add Profile</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New Operator Profile</DialogTitle></DialogHeader>
            <ProfileForm printers={printers} users={users} onSave={d => save.mutate(d)} onClose={() => setDialog(null)} />
          </DialogContent>
        </Dialog>
      </div>
      <div className="bg-card border border-border/50 rounded-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow className="border-border/50">
              <TableHead className="text-xs uppercase tracking-wider">Operator</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Receipt</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Pi Fallback</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Label</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profiles.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="h-20 text-center text-muted-foreground text-xs">
                No profiles yet. Add one above to assign printers to each operator.
              </TableCell></TableRow>
            ) : profiles.map(p => (
              <TableRow key={p.id} className="border-border/30 hover:bg-muted/20">
                <TableCell>
                  <div className="font-medium text-sm">{p.email}</div>
                  <div className="text-xs text-muted-foreground">{p.role}</div>
                  {p.isDefault && <Badge variant="outline" className="text-xs mt-1">Default</Badge>}
                </TableCell>
                <TableCell className="text-sm">{printerName(p.receiptPrinterId)}</TableCell>
                <TableCell className="text-sm">{printerName(p.fallbackReceiptPrinterId)}</TableCell>
                <TableCell className="text-sm">{printerName(p.labelPrinterId)}</TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    <Dialog open={dialog === p} onOpenChange={o => setDialog(o ? p : null)}>
                      <DialogTrigger asChild><Button size="sm" variant="outline">Edit</Button></DialogTrigger>
                      <DialogContent>
                        <DialogHeader><DialogTitle>Edit Profile — {p.email}</DialogTitle></DialogHeader>
                        <ProfileForm profile={p} printers={printers} users={users} onSave={d => save.mutate(d)} onClose={() => setDialog(null)} />
                      </DialogContent>
                    </Dialog>
                    <Button size="sm" variant="destructive" onClick={() => { if (confirm("Delete profile?")) del.mutate(p.id); }}>Del</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ── JOBS TAB ──────────────────────────────────────────────────────────────────
function JobDetail({ jobId }: { jobId: number }) {
  const apiFetch = useApiFetch();
  const { data, isLoading } = useQuery({ queryKey: ["print-job-detail", jobId], queryFn: () => apiFetch(`/api/print/jobs/${jobId}`) as Promise<{ job: PrintJob; attempts: { id: number; attemptNumber: number; routeUsed?: string; success: boolean; errorMessage?: string; durationMs?: number; createdAt: string }[] }> });
  if (isLoading) return <div className="text-xs text-muted-foreground">Loading attempts…</div>;
  const job = (data as { job: PrintJob })?.job;
  const attempts = (data as { attempts: { id: number; attemptNumber: number; routeUsed?: string; success: boolean; errorMessage?: string; durationMs?: number; createdAt: string }[] })?.attempts ?? [];
  return (
    <div className="space-y-2">
      {job?.errorMessage && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2 flex items-start gap-2">
          <XCircle size={12} className="shrink-0 mt-0.5" />
          <div><div className="font-medium">Error</div><div className="mt-0.5 text-red-400/80">{job.errorMessage}</div></div>
        </div>
      )}
      {attempts.length === 0 ? <div className="text-xs text-muted-foreground">No dispatch attempts recorded.</div> : (
        <div className="space-y-1.5">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Dispatch Attempts</div>
          {attempts.map(a => (
            <div key={a.id} className={`flex items-start gap-3 text-xs rounded px-3 py-2 ${a.success ? "bg-green-500/5 border border-green-500/15" : "bg-red-500/5 border border-red-500/15"}`}>
              {a.success ? <CheckCircle2 size={12} className="text-green-400 shrink-0 mt-0.5" /> : <XCircle size={12} className="text-red-400 shrink-0 mt-0.5" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">Attempt #{a.attemptNumber}</span>
                  {a.routeUsed && <Badge variant="outline" className="text-xs">{connLabel(a.routeUsed)}</Badge>}
                  {a.durationMs !== undefined && <span className="text-muted-foreground">{a.durationMs}ms</span>}
                  <span className="text-muted-foreground ml-auto">{new Date(a.createdAt).toLocaleTimeString()}</span>
                </div>
                {a.errorMessage && <div className="text-red-400/80 mt-0.5 leading-relaxed break-words">{a.errorMessage}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JobsTab() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["print-jobs", filter],
    queryFn: () => apiFetch(`/api/print/jobs${filter !== "all" ? `?status=${filter}` : ""}`) as Promise<{ jobs: PrintJob[] }>,
    refetchInterval: 10_000,
  });

  const retry = useMutation({ mutationFn: (id: number) => apiFetch(`/api/print/jobs/${id}/retry`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["print-jobs"] }) });
  const reprint = useMutation({ mutationFn: (id: number) => apiFetch(`/api/print/jobs/${id}/reprint`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["print-jobs"] }) });

  const jobs: PrintJob[] = (data as { jobs: PrintJob[] })?.jobs ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">Print Jobs & Logs</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Click any row to expand attempt details.</p>
        </div>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["all", "queued", "sending", "printed", "retrying", "failed"].map(s => (
              <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="bg-card border border-border/50 rounded-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow className="border-border/50">
              <TableHead className="text-xs uppercase tracking-wider">ID</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Order</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Type</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Status</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Via</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Retries</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Created</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="h-20 text-center text-muted-foreground text-xs">Loading…</TableCell></TableRow>
            ) : jobs.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="h-20 text-center text-muted-foreground text-xs">No jobs found.</TableCell></TableRow>
            ) : jobs.map(j => (
              <Fragment key={j.id}>
                <TableRow className="border-border/30 hover:bg-muted/20 cursor-pointer" onClick={() => setExpanded(e => e === j.id ? null : j.id)}>
                  <TableCell className="font-mono text-xs">{j.id}</TableCell>
                  <TableCell className="font-mono text-xs">{j.orderId ?? "—"}</TableCell>
                  <TableCell className="text-xs capitalize">{j.jobType.replace("_", " ")}</TableCell>
                  <TableCell><Badge variant="outline" className={`text-xs ${statusColor(j.status)}`}>{j.status}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{j.printedVia ? connLabel(j.printedVia) : "—"}</TableCell>
                  <TableCell className="text-xs text-center">{j.retryCount}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(j.createdAt).toLocaleString()}</TableCell>
                  <TableCell onClick={e => e.stopPropagation()}>
                    <div className="flex gap-1">
                      {(j.status === "failed" || j.status === "retrying") && <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => retry.mutate(j.id)}>Retry</Button>}
                      <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => reprint.mutate(j.id)}>Reprint</Button>
                    </div>
                  </TableCell>
                </TableRow>
                {expanded === j.id && (
                  <TableRow className="bg-muted/5 border-border/20">
                    <TableCell colSpan={8} className="py-3 px-4"><JobDetail jobId={j.id} /></TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ── TEMPLATES TAB ─────────────────────────────────────────────────────────────
function TemplateForm({ template, onSave, onClose }: {
  template?: PrintTemplate; onSave: (d: object) => void; onClose: () => void;
}) {
  const [form, setForm] = useState({
    name: template?.name ?? "",
    jobType: template?.jobType ?? "label",
    paperWidth: template?.paperWidth ?? "58mm",
    paperHeight: template?.paperHeight ?? "auto",
    isDefault: template?.isDefault ?? false,
    isActive: template?.isActive ?? true,
    templateJson: template?.templateJson ? JSON.stringify(template.templateJson, null, 2) : JSON.stringify([
      { key: "id", label: "Order #", x: 0, y: 30, fontSize: 20, fontWeight: "bold", align: "center" },
      { key: "customerName", label: "Customer", x: 0, y: 60, fontSize: 14 },
      { key: "total", label: "Total", x: 0, y: 80, fontSize: 14 },
    ], null, 2),
  });
  const [jsonError, setJsonError] = useState("");

  const save = () => {
    try {
      const parsed = JSON.parse(form.templateJson);
      onSave({ ...form, templateJson: parsed });
      onClose();
    } catch { setJsonError("Invalid JSON — check your field definitions"); }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Name</Label>
          <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label>Type</Label>
          <Select value={form.jobType} onValueChange={v => setForm(f => ({ ...f, jobType: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="label">Label</SelectItem>
              <SelectItem value="receipt">Receipt</SelectItem>
              <SelectItem value="order_ticket">Order Ticket</SelectItem>
            </SelectContent>
          </Select>
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
        <div className="space-y-1">
          <Label>Paper Height</Label>
          <Input value={form.paperHeight} onChange={e => setForm(f => ({ ...f, paperHeight: e.target.value }))} placeholder="auto or 200mm" />
        </div>
      </div>
      <div className="space-y-1">
        <Label>Field Definitions (JSON)</Label>
        <Textarea value={form.templateJson} onChange={e => { setForm(f => ({ ...f, templateJson: e.target.value })); setJsonError(""); }} className="font-mono text-xs h-48" />
        {jsonError && <div className="text-xs text-red-400">{jsonError}</div>}
        <div className="text-xs text-muted-foreground">Array of: {"{ key, label?, x?, y?, fontSize?, fontWeight?, align? }"}</div>
      </div>
      <div className="flex gap-6">
        <div className="flex items-center gap-2"><Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} /><Label>Active</Label></div>
        <div className="flex items-center gap-2"><Switch checked={form.isDefault} onCheckedChange={v => setForm(f => ({ ...f, isDefault: v }))} /><Label>Default</Label></div>
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={save}>Save Template</Button>
      </div>
    </div>
  );
}

function TemplatesTab() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<PrintTemplate | "new" | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ["print-templates"], queryFn: () => apiFetch("/api/print/templates") as Promise<{ templates: PrintTemplate[] }> });
  const create = useMutation({ mutationFn: (d: object) => apiFetch("/api/print/templates", { method: "POST", body: JSON.stringify(d) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["print-templates"] }) });
  const update = useMutation({ mutationFn: ({ id, d }: { id: number; d: object }) => apiFetch(`/api/print/templates/${id}`, { method: "PATCH", body: JSON.stringify(d) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["print-templates"] }) });
  const del = useMutation({ mutationFn: (id: number) => apiFetch(`/api/print/templates/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["print-templates"] }) });

  const templates: PrintTemplate[] = (data as { templates: PrintTemplate[] })?.templates ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">Label & Receipt Templates</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Define field layouts for label and receipt prints.</p>
        </div>
        <Dialog open={dialog === "new"} onOpenChange={o => setDialog(o ? "new" : null)}>
          <DialogTrigger asChild><Button>+ Add Template</Button></DialogTrigger>
          <DialogContent className="max-w-xl">
            <DialogHeader><DialogTitle>New Template</DialogTitle></DialogHeader>
            <TemplateForm onSave={d => create.mutate(d)} onClose={() => setDialog(null)} />
          </DialogContent>
        </Dialog>
      </div>
      <div className="bg-card border border-border/50 rounded-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow className="border-border/50">
              <TableHead className="text-xs uppercase tracking-wider">Name</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Type</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Paper</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Fields</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Status</TableHead>
              <TableHead className="text-xs uppercase tracking-wider">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="h-20 text-center text-muted-foreground text-xs">Loading…</TableCell></TableRow>
            ) : templates.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-20 text-center text-muted-foreground text-xs">No templates yet. Add one above.</TableCell></TableRow>
            ) : templates.map(t => (
              <TableRow key={t.id} className="border-border/30 hover:bg-muted/20">
                <TableCell className="font-medium text-sm">{t.name}{t.isDefault && <Badge variant="outline" className="text-xs ml-2">Default</Badge>}</TableCell>
                <TableCell className="text-xs capitalize">{t.jobType.replace("_", " ")}</TableCell>
                <TableCell className="text-xs">{t.paperWidth}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{(t.templateJson as unknown[]).length} fields</TableCell>
                <TableCell><Badge variant="outline" className={`text-xs ${t.isActive ? "text-green-400 border-green-500/30" : "text-muted-foreground"}`}>{t.isActive ? "Active" : "Inactive"}</Badge></TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    <Dialog open={dialog === t} onOpenChange={o => setDialog(o ? t : null)}>
                      <DialogTrigger asChild><Button size="sm" variant="outline">Edit</Button></DialogTrigger>
                      <DialogContent className="max-w-xl">
                        <DialogHeader><DialogTitle>Edit Template</DialogTitle></DialogHeader>
                        <TemplateForm template={t} onSave={d => update.mutate({ id: t.id, d })} onClose={() => setDialog(null)} />
                      </DialogContent>
                    </Dialog>
                    <Button size="sm" variant="destructive" onClick={() => { if (confirm("Delete template?")) del.mutate(t.id); }}>Del</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ── THANK YOU LABEL TAB ───────────────────────────────────────────────────────
function ThankYouLabelTab() {
  const apiFetch = useApiFetch();
  const { getToken } = useAuth();
  const [name, setName] = useState("");
  const [copies, setCopies] = useState(1);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [printResult, setPrintResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [printLoading, setPrintLoading] = useState(false);

  const firstName = name.trim() || "Friend";

  async function loadPreview() {
    setPreviewLoading(true);
    setPrintResult(null);
    try {
      const token = await getToken();
      const res = await fetch(
        `/api/print/preview/thank-you-label?name=${encodeURIComponent(firstName)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (e: unknown) {
      setPrintResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function printLabel() {
    setPrintLoading(true);
    setPrintResult(null);
    try {
      const data = await apiFetch("/api/print/label/thank-you", {
        method: "POST",
        body: JSON.stringify({ firstName, copies }),
      }) as { ok: boolean; jobId: number; status: string; printerName: string; error?: string };
      setPrintResult({
        ok: data.ok,
        message: data.ok
          ? `Printed to ${data.printerName} (job #${data.jobId})`
          : (data.error ?? `Job ${data.status}`),
      });
    } catch (e: unknown) {
      setPrintResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setPrintLoading(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold mb-1">Thank You Sticker Label</h2>
        <p className="text-sm text-muted-foreground">
          Generates a personalized 2″ × 2″ circular sticker with the customer's first name
          printed inside the LuciferCruz.com bowl design.
        </p>
      </div>

      <div className="bg-card border border-border/50 rounded-sm p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="ty-name">Customer First Name</Label>
            <Input
              id="ty-name"
              placeholder="e.g. Samantha"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={20}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ty-copies">Copies</Label>
            <Input
              id="ty-copies"
              type="number"
              min={1}
              max={5}
              value={copies}
              onChange={e => setCopies(Math.min(5, Math.max(1, Number(e.target.value))))}
            />
          </div>
        </div>

        <div className="flex gap-3">
          <Button variant="outline" onClick={loadPreview} disabled={previewLoading}>
            {previewLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Eye className="w-4 h-4 mr-2" />}
            Preview
          </Button>
          <Button onClick={printLabel} disabled={printLoading}>
            {printLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Printer className="w-4 h-4 mr-2" />}
            Print Thank You
          </Button>
        </div>

        {printResult && (
          <div className={`flex items-center gap-2 text-sm rounded-sm px-3 py-2 border ${
            printResult.ok
              ? "bg-green-500/10 text-green-400 border-green-500/30"
              : "bg-red-500/10 text-red-400 border-red-500/30"
          }`}>
            {printResult.ok
              ? <CheckCircle2 className="w-4 h-4 shrink-0" />
              : <XCircle className="w-4 h-4 shrink-0" />}
            {printResult.message}
          </div>
        )}
      </div>

      {previewUrl && (
        <div className="bg-card border border-border/50 rounded-sm p-5 space-y-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Tag className="w-3.5 h-3.5" />
            Label Preview — <span className="font-mono">{firstName}</span>
            <span className="ml-auto text-muted-foreground/60">406 × 406 px (2″ at 203 DPI)</span>
          </div>
          <div className="flex justify-center">
            <img
              src={previewUrl}
              alt={`Thank You label for ${firstName}`}
              className="w-64 h-64 object-contain border border-border/30 rounded-sm shadow-sm"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── SETTINGS BAR ──────────────────────────────────────────────────────────────
function SettingsBar() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["print-settings"], queryFn: () => apiFetch("/api/print/settings") as Promise<{ settings: Record<string, unknown> }> });
  const update = useMutation({ mutationFn: (d: object) => apiFetch("/api/print/settings", { method: "PATCH", body: JSON.stringify(d) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["print-settings"] }) });
  const s = (data as { settings: Record<string, unknown> })?.settings;
  if (!s) return null;

  return (
    <div className="bg-card border border-border/50 rounded-sm p-4 flex flex-wrap items-center gap-6">
      {[
        { key: "autoPrintOrders", label: "Auto-print kitchen tickets" },
        { key: "autoPrintReceipts", label: "Auto-print receipts" },
        { key: "autoPrintLabels", label: "Auto-print labels" },
        { key: "alertOnLabelFailure", label: "SMS alert on label failure" },
      ].map(({ key, label }) => (
        <div key={key} className="flex items-center gap-2">
          <Switch checked={Boolean(s[key])} onCheckedChange={v => update.mutate({ [key]: v })} />
          <span className="text-sm">{label}</span>
        </div>
      ))}
    </div>
  );
}

// ── ROOT ──────────────────────────────────────────────────────────────────────
export default function AdminPrint() {
  return (
    <PrintProvider>
      <div className="space-y-6 max-w-7xl mx-auto">
        <div className="border-b border-border/50 pb-4">
          <h1 className="text-3xl font-bold tracking-tight mb-1">Print Management</h1>
          <p className="text-muted-foreground text-sm">
            Mac print bridge on Tailscale (port 3001) · Receipt: <span className="font-mono">Reciept_POS80_Printer</span> · Label: <span className="font-mono">Label_Themal_Printer</span>
          </p>
        </div>

        <SettingsBar />

        <Tabs defaultValue="printers">
          <TabsList className="mb-4">
            <TabsTrigger value="printers">Printers</TabsTrigger>
            <TabsTrigger value="routing">Routing</TabsTrigger>
            <TabsTrigger value="profiles">Profiles</TabsTrigger>
            <TabsTrigger value="jobs">Jobs & Logs</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            <TabsTrigger value="labels">Labels</TabsTrigger>
          </TabsList>
          <TabsContent value="printers"><PrintersTab /></TabsContent>
          <TabsContent value="routing"><RoutingTab /></TabsContent>
          <TabsContent value="profiles"><ProfilesTab /></TabsContent>
          <TabsContent value="jobs"><JobsTab /></TabsContent>
          <TabsContent value="templates"><TemplatesTab /></TabsContent>
          <TabsContent value="labels"><ThankYouLabelTab /></TabsContent>
        </Tabs>
      </div>
    </PrintProvider>
  );
}
