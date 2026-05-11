/**
 * Admin → Print Management (Task #9 — simplified).
 *
 * Two clear modes per role (receipt, label):
 *   - Local VPS CUPS (lp -d <queue>)  ← primary, no network hop
 *   - Print Bridge over Tailscale     ← optional fallback for local Mac/Pi
 *
 * Eight settings + two test buttons + a status panel. Nothing else.
 */

import { useCallback, useState, useContext, createContext, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle2, XCircle, Loader2, Printer, Tag, Server, RefreshCw } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type Method = "local_cups" | "bridge";

interface SimpleSettings {
  receiptEnabled: boolean;
  receiptMethod: Method;
  receiptPrinterName: string;
  labelEnabled: boolean;
  labelMethod: Method;
  labelPrinterName: string;
  autoPrintReceipts: boolean;
  lastTestResult: { ts: string; role: string; mode: Method; ok: boolean; message: string } | null;
  bridgeUrl: string;
  bridgeApiKeySet: boolean;
}

interface TestResponse {
  ok: boolean;
  role: "receipt" | "label";
  mode: Method;
  printerName: string;
  message: string;
  jobRef?: string;
  latencyMs?: number;
  exitCode?: number | null;
}

interface StatusResponse {
  ok: boolean;
  cups: { ok: boolean; queues: string[]; message: string };
  bridge: { ok: boolean; latencyMs?: number; status?: number; message: string; url: string; defaultUrl: string };
}

// ── API context ──────────────────────────────────────────────────────────────
type ApiFetchFn = (path: string, init?: RequestInit) => Promise<unknown>;
const ApiFetchCtx = createContext<ApiFetchFn | null>(null);
function useApiFetch(): ApiFetchFn {
  const fn = useContext(ApiFetchCtx);
  if (!fn) throw new Error("Must be inside PrintProvider");
  return fn;
}

function PrintProvider({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const apiFetch: ApiFetchFn = useCallback(async (path, init) => {
    const token = await getToken();
    const res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const msg = (body && typeof body === "object" && "message" in (body as object))
        ? String((body as { message?: unknown }).message)
        : (body && typeof body === "object" && "error" in (body as object))
          ? String((body as { error?: unknown }).error)
          : (typeof body === "string" ? body : `HTTP ${res.status}`);
      throw new Error(msg);
    }
    return body;
  }, [getToken]);
  return <ApiFetchCtx.Provider value={apiFetch}>{children}</ApiFetchCtx.Provider>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function methodLabel(m: Method) {
  return m === "local_cups" ? "Local VPS CUPS (lp)" : "Print Bridge (Tailscale)";
}

function ResultBanner({ result, onDismiss }: { result: TestResponse | null; onDismiss: () => void }) {
  if (!result) return null;
  const cls = result.ok
    ? "border-green-500/30 bg-green-500/10 text-green-300"
    : "border-red-500/30 bg-red-500/10 text-red-300";
  const Icon = result.ok ? CheckCircle2 : XCircle;
  return (
    <div className={`rounded border ${cls} px-3 py-2 text-xs flex items-start gap-2`}>
      <Icon size={14} className="mt-0.5 shrink-0" />
      <div className="flex-1 space-y-0.5">
        <div>
          <span className="font-semibold uppercase tracking-wider">
            {result.role === "receipt" ? "Receipt" : "Label"} · {methodLabel(result.mode)}
          </span>
          {result.printerName && <span className="ml-2 font-mono text-foreground/80">{result.printerName}</span>}
        </div>
        <div className="text-foreground/80">{result.message}</div>
        {result.jobRef && <div className="text-foreground/50 font-mono">Job: {result.jobRef}</div>}
      </div>
      <button onClick={onDismiss} className="text-foreground/60 hover:text-foreground" aria-label="Dismiss">×</button>
    </div>
  );
}

// ── Section: per-role controls ───────────────────────────────────────────────
function RoleCard({
  icon: Icon,
  title,
  enabled, method, printerName,
  defaultName,
  onChange, onTest,
  testing, lastResult, onDismissResult,
}: {
  icon: typeof Printer;
  title: string;
  enabled: boolean; method: Method; printerName: string;
  defaultName: string;
  onChange: (patch: Partial<SimpleSettings>) => void;
  onTest: () => void;
  testing: boolean;
  lastResult: TestResponse | null;
  onDismissResult: () => void;
}) {
  return (
    <div className="bg-card border border-border/50 rounded-sm p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={16} className="text-muted-foreground" />
          <h3 className="text-base font-semibold">{title}</h3>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={enabled} onCheckedChange={(v) => onChange(title === "Receipts"
            ? { receiptEnabled: v }
            : { labelEnabled: v })} />
          <span className="text-xs text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Mode</Label>
          <Select
            value={method}
            onValueChange={(v) => onChange(title === "Receipts"
              ? { receiptMethod: v as Method }
              : { labelMethod: v as Method })}
          >
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="local_cups">Local VPS CUPS (lp -d)</SelectItem>
              <SelectItem value="bridge">Print Bridge (Tailscale)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            {method === "local_cups" ? "CUPS Queue Name" : "Bridge Printer Name"}
          </Label>
          <Input
            className="h-9 font-mono"
            value={printerName}
            placeholder={defaultName}
            onChange={(e) => onChange(title === "Receipts"
              ? { receiptPrinterName: e.target.value }
              : { labelPrinterName: e.target.value })}
          />
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <div className="text-xs text-muted-foreground">
          {method === "local_cups"
            ? <>Runs <span className="font-mono">lp -d {printerName || defaultName}</span> on this VPS.</>
            : <>POSTs to the Tailscale bridge as <span className="font-mono">{printerName || defaultName}</span>.</>}
        </div>
        <Button size="sm" variant="outline" disabled={!enabled || testing} onClick={onTest}>
          {testing ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
          Test {title === "Receipts" ? "Receipt" : "Label"}
        </Button>
      </div>

      {lastResult && <ResultBanner result={lastResult} onDismiss={onDismissResult} />}
    </div>
  );
}

// ── Status panel ─────────────────────────────────────────────────────────────
function StatusPanel() {
  const apiFetch = useApiFetch();
  const { data, isFetching, refetch } = useQuery<StatusResponse>({
    queryKey: ["admin-printers-status"],
    queryFn: () => apiFetch("/api/admin/printers/status") as Promise<StatusResponse>,
    refetchInterval: 60_000,
  });

  return (
    <div className="bg-card border border-border/50 rounded-sm p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold uppercase tracking-wider">Status</h3>
        </div>
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw size={12} className={`mr-1 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Local CUPS</span>
            {data && (
              <Badge variant="outline" className={data.cups.ok ? "text-green-400 border-green-500/30" : "text-red-400 border-red-500/30"}>
                {data.cups.ok ? "OK" : "Down"}
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground">{data?.cups.message ?? "Loading…"}</div>
          {data?.cups.queues?.length ? (
            <div className="font-mono text-foreground/70">Queues: {data.cups.queues.join(", ")}</div>
          ) : null}
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Print Bridge</span>
            {data && (
              <Badge variant="outline" className={data.bridge.ok ? "text-green-400 border-green-500/30" : "text-red-400 border-red-500/30"}>
                {data.bridge.ok ? `OK · ${data.bridge.latencyMs ?? "?"}ms` : "Unreachable"}
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground">{data?.bridge.message ?? "Loading…"}</div>
          <div className="font-mono text-foreground/70">{data?.bridge.url ?? "—"}</div>
        </div>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
function PrintAdminInner() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  const [pendingPatch, setPendingPatch] = useState<Partial<SimpleSettings>>({});
  const [testingRole, setTestingRole] = useState<"receipt" | "label" | null>(null);
  const [results, setResults] = useState<{ receipt?: TestResponse; label?: TestResponse }>({});

  const { data, isLoading } = useQuery<{ settings: SimpleSettings }>({
    queryKey: ["admin-printers-settings"],
    queryFn: () => apiFetch("/api/admin/printers/settings") as Promise<{ settings: SimpleSettings }>,
  });

  const patch = useMutation({
    mutationFn: (body: Partial<SimpleSettings>) =>
      apiFetch("/api/admin/printers/settings", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      setPendingPatch({});
      qc.invalidateQueries({ queryKey: ["admin-printers-settings"] });
    },
  });

  const testReceipt = useMutation({
    mutationFn: () => apiFetch("/api/admin/printers/test-receipt", { method: "POST" }) as Promise<TestResponse>,
    onMutate: () => setTestingRole("receipt"),
    onSettled: () => setTestingRole(null),
    onSuccess: (r) => setResults((s) => ({ ...s, receipt: r })),
    onError: (err: Error) => setResults((s) => ({
      ...s,
      receipt: { ok: false, role: "receipt", mode: settings.receiptMethod, printerName: settings.receiptPrinterName, message: err.message },
    })),
  });
  const testLabel = useMutation({
    mutationFn: () => apiFetch("/api/admin/printers/test-label", { method: "POST" }) as Promise<TestResponse>,
    onMutate: () => setTestingRole("label"),
    onSettled: () => setTestingRole(null),
    onSuccess: (r) => setResults((s) => ({ ...s, label: r })),
    onError: (err: Error) => setResults((s) => ({
      ...s,
      label: { ok: false, role: "label", mode: settings.labelMethod, printerName: settings.labelPrinterName, message: err.message },
    })),
  });

  if (isLoading || !data) {
    return <div className="text-muted-foreground text-sm py-12 text-center">Loading printer settings…</div>;
  }

  const settings: SimpleSettings = { ...data.settings, ...pendingPatch };

  const onChange = (p: Partial<SimpleSettings>) => {
    setPendingPatch((cur) => ({ ...cur, ...p }));
  };
  const save = () => patch.mutate(pendingPatch);
  const dirty = Object.keys(pendingPatch).length > 0;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="border-b border-border/50 pb-4 flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-1">Print Management</h1>
          <p className="text-muted-foreground text-sm">
            Two clear modes: <span className="font-mono">lp</span> on this VPS, or the Print Bridge at{" "}
            <span className="font-mono">{settings.bridgeUrl}</span>.
          </p>
        </div>
        <Button onClick={save} disabled={!dirty || patch.isPending}>
          {patch.isPending ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
          {dirty ? "Save changes" : "Saved"}
        </Button>
      </div>

      <div className="bg-card border border-border/50 rounded-sm p-4 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Auto-print receipts</div>
          <div className="text-xs text-muted-foreground">When enabled, receipts print automatically on payment.</div>
        </div>
        <Switch
          checked={settings.autoPrintReceipts}
          onCheckedChange={(v) => onChange({ autoPrintReceipts: v })}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RoleCard
          icon={Printer}
          title="Receipts"
          enabled={settings.receiptEnabled}
          method={settings.receiptMethod}
          printerName={settings.receiptPrinterName}
          defaultName="receipt"
          onChange={onChange}
          onTest={() => testReceipt.mutate()}
          testing={testingRole === "receipt"}
          lastResult={results.receipt ?? null}
          onDismissResult={() => setResults((s) => ({ ...s, receipt: undefined }))}
        />
        <RoleCard
          icon={Tag}
          title="Labels"
          enabled={settings.labelEnabled}
          method={settings.labelMethod}
          printerName={settings.labelPrinterName}
          defaultName="label"
          onChange={onChange}
          onTest={() => testLabel.mutate()}
          testing={testingRole === "label"}
          lastResult={results.label ?? null}
          onDismissResult={() => setResults((s) => ({ ...s, label: undefined }))}
        />
      </div>

      <StatusPanel />

      {settings.lastTestResult && (
        <div className="text-xs text-muted-foreground">
          Last test: {settings.lastTestResult.role} · {methodLabel(settings.lastTestResult.mode)} ·{" "}
          {settings.lastTestResult.ok ? "OK" : "Failed"} ·{" "}
          {new Date(settings.lastTestResult.ts).toLocaleString()} — {settings.lastTestResult.message}
        </div>
      )}
    </div>
  );
}

export default function AdminPrint() {
  return (
    <PrintProvider>
      <PrintAdminInner />
    </PrintProvider>
  );
}
