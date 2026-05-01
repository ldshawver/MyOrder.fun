import { useState, useRef, useCallback } from "react";
import {
  Upload, Download, FileText, CheckCircle2, AlertCircle,
  RotateCcw, ChevronRight, RefreshCw, ShoppingBag,
  FlaskConical, ArrowRight, Table2, Settings, HelpCircle,
  ChevronDown, ChevronUp, Columns, AlertTriangle, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { DebugPanel, type DebugEntry } from "@/components/debug-panel";

// ─── Template column reference ─────────────────────────────────────────────────
const REQUIRED_COLS = [
  { friendly: "Regular Price",  canonical: "regular_price" },
  { friendly: "Menu Name",      canonical: "alavont_name" },
  { friendly: "Menu Category",  canonical: "alavont_category" },
  { friendly: "Merchant Name",  canonical: "lucifer_cruz_name" },
  { friendly: "Merchant SKU",   canonical: "lab_name" },
];

const OPTIONAL_COLS = [
  "Menu Image URL", "Menu Description", "Menu In Stock", "Menu ID",
  "Menu Amount", "Menu Measurement",
  "Merchant Price", "Merchant Image URL", "Merchant Description",
  "Merchant Category", "Merchant In Stock", "Merchant ID",
  "Merchant Created Date", "Merchant Updated Date",
  "Merchant Created By ID", "Merchant Created By",
];

const TEMPLATE_HEADERS = [
  "Regular Price", "Menu Image URL", "Menu Name", "Menu Description",
  "Menu Category", "Menu In Stock", "Menu ID", "Menu Amount",
  "Menu Measurement", "Merchant Price", "Merchant Name",
  "Merchant Image URL", "Merchant Description", "Merchant Category",
  "Merchant In Stock", "Merchant ID", "Merchant Created Date",
  "Merchant Updated Date", "Merchant Created By ID", "Merchant Created By",
  "Merchant SKU",
];

// ─── Types ────────────────────────────────────────────────────────────────────
type HeaderMapping = { original: string; canonical: string; recognized: boolean };

type RequiredField = {
  canonical: string;
  friendlyName: string;
  found: boolean;
  mappedFrom: string | null;
};

type CanonicalInfo = {
  canonical: string;
  friendlyName: string;
  required: boolean;
};

type ParsedHeaders = {
  headerMappings: HeaderMapping[];
  missingRequired: string[];
  unknownHeaders: string[];
  requiredFields: RequiredField[];
  allCanonicals: CanonicalInfo[];
  fileColumns: string[];
};

type ImportResult = {
  dryRun: boolean;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
  warnings?: string[];
  unknownHeaders?: string[];
  total: number;
  headerMappings?: HeaderMapping[];
};

// ─── Client-side CSV preview parser ──────────────────────────────────────────
function parseCsvPreview(text: string): { rawHeaders: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 1) return { rawHeaders: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let cur = "", inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQuote && line[i + 1] === '"') { cur += '"'; i++; } else inQuote = !inQuote; }
      else if (c === "," && !inQuote) { result.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    result.push(cur.trim());
    return result;
  };
  const rawHeaders = parseLine(lines[0]);
  const rows = lines.slice(1, 6).map(line => {
    const vals = parseLine(line);
    const obj: Record<string, string> = {};
    rawHeaders.forEach((h, i) => { obj[h] = vals[i] ?? ""; });
    return obj;
  });
  return { rawHeaders, rows };
}

// ─── WooCommerce Sync ─────────────────────────────────────────────────────────
type WooStatus = { configured: boolean; storeUrl: string };

function WooCommerceSync() {
  const { getToken } = useAuth();
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wooStatus, setWooStatus] = useState<WooStatus | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/woocommerce/status", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setWooStatus(await res.json());
    } catch { /* ignore */ }
  }, [getToken]);

  useState(() => { void fetchStatus(); });

  async function handleSync() {
    setSyncing(true); setError(null); setResult(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/woocommerce/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Sync failed"); return; }
      setResult(data);
    } catch (e) {
      setError((e as Error)?.message ?? "Network error");
    } finally { setSyncing(false); }
  }

  const configured = wooStatus?.configured ?? false;

  return (
    <div className="rounded-2xl border border-border/50 bg-card/50 overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/30"
        style={{ background: "linear-gradient(135deg, rgba(220,20,60,0.08), rgba(139,0,0,0.04))" }}>
        <div className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: "linear-gradient(135deg, #DC143C, #8B0000)" }}>
          <ShoppingBag size={16} className="text-white" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold">Lucifer Cruz · WooCommerce Sync</div>
          <div className="text-xs text-muted-foreground">
            {configured ? `Credentials saved · Store: ${wooStatus?.storeUrl}` : "API credentials not configured — set them in Admin Settings"}
          </div>
        </div>
      </div>
      <div className="p-5 space-y-4">
        {!configured && (
          <div className="flex items-center gap-3 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-400 text-xs">
            <AlertCircle size={14} className="shrink-0" />
            <span>WooCommerce credentials are not saved yet. Go to <strong>Admin Settings → WooCommerce</strong> to configure.</span>
            <a href="/admin/settings" className="ml-auto shrink-0 flex items-center gap-1 font-semibold underline">
              <Settings size={12} /> Settings
            </a>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span className="text-xs">{error}</span>
          </div>
        )}
        {result && !error && <ResultCards result={result} />}
        <Button onClick={handleSync} disabled={syncing || !configured} className="gap-2 rounded-xl w-full sm:w-auto"
          style={(configured && !syncing) ? { background: "linear-gradient(135deg, #DC143C, #8B0000)", color: "#fff" } : {}}>
          {syncing ? <><RefreshCw size={14} className="animate-spin" /> Syncing...</> : <><RefreshCw size={14} /> Sync from WooCommerce</>}
        </Button>
      </div>
    </div>
  );
}

// ─── Result cards ─────────────────────────────────────────────────────────────
function ResultCards({ result }: { result: ImportResult }) {
  const stats = [
    { label: "Inserted", value: result.inserted, color: "#10b981" },
    { label: "Updated",  value: result.updated,  color: "#3b82f6" },
    { label: "Skipped",  value: result.skipped,  color: "#f59e0b" },
    { label: "Failed",   value: result.failed ?? 0, color: "#ef4444" },
    { label: "Total",    value: result.total,    color: "#6b7280" },
  ];
  return (
    <div className="space-y-3">
      {result.dryRun && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300 text-xs font-semibold">
          <FlaskConical size={13} /> Dry run — no data was written
        </div>
      )}
      <div className="grid grid-cols-5 gap-2">
        {stats.map(({ label, value, color }) => (
          <div key={label} className="glass-card rounded-xl p-3 border border-border/40 text-center">
            <div className="text-xl font-bold" style={{ color }}>{value}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
          </div>
        ))}
      </div>
      {(result.warnings ?? []).length > 0 && (
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.05] p-3 space-y-1">
          <div className="flex items-center gap-2 text-blue-400 font-semibold text-xs mb-1">
            <AlertCircle size={12} /> {result.warnings!.length} column warning{result.warnings!.length !== 1 ? "s" : ""}
          </div>
          {result.warnings!.map((w, i) => (
            <div key={i} className="text-[11px] text-blue-300/70 font-mono flex gap-1.5">
              <ChevronRight size={10} className="shrink-0 mt-0.5" />{w}
            </div>
          ))}
        </div>
      )}
      {result.errors.length > 0 && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/[0.05] p-3 max-h-48 overflow-y-auto space-y-1">
          <div className="flex items-center gap-2 text-yellow-400 font-semibold text-xs mb-2">
            <AlertCircle size={12} /> {result.errors.length} row error{result.errors.length !== 1 ? "s" : ""}
          </div>
          {result.errors.map((e, i) => (
            <div key={i} className="text-[11px] text-yellow-300/70 font-mono flex gap-1.5">
              <ChevronRight size={10} className="shrink-0 mt-0.5" />{e}
            </div>
          ))}
        </div>
      )}
      {result.errors.length === 0 && (
        <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold">
          <CheckCircle2 size={13} /> {result.dryRun ? "Dry run passed" : "Import complete"} — all {result.total} rows processed
        </div>
      )}
    </div>
  );
}

// ─── Expected columns reference (collapsible) ─────────────────────────────────
function ExpectedColumnsRef() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-muted/10 hover:bg-muted/20 transition-colors text-left"
      >
        <HelpCircle size={13} className="text-muted-foreground shrink-0" />
        <span className="text-xs font-semibold text-muted-foreground flex-1">Expected columns (full reference)</span>
        {open ? <ChevronUp size={13} className="text-muted-foreground" /> : <ChevronDown size={13} className="text-muted-foreground" />}
      </button>
      {open && (
        <div className="p-4 space-y-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-red-400 mb-1.5">Required</div>
            <div className="flex flex-wrap gap-1.5">
              {REQUIRED_COLS.map(c => (
                <span key={c.canonical} className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                  {c.friendly}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">Optional</div>
            <div className="flex flex-wrap gap-1.5">
              {OPTIONAL_COLS.map(c => (
                <span key={c} className="text-[11px] font-mono px-2 py-0.5 rounded-full border border-border/40 bg-muted/20 text-muted-foreground">{c}</span>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground/60">
            Column names are case-insensitive. Aliases like "Menu Name", "menu_name", and "alavont_name" all map to the same field. Download the template for an exact starting point.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Column mapper ─────────────────────────────────────────────────────────────
// Shows required fields and lets the user pick which file column maps to each.
// Also displays unrecognized file columns (strict mode: clearly flagged).
interface ColumnMapperProps {
  parsedData: ParsedHeaders;
  userMapping: Record<string, string>;           // canonical → originalCol (UI state)
  onMap: (canonical: string, originalCol: string) => void;
  onUnmap: (canonical: string) => void;
}

function ColumnMapper({ parsedData, userMapping, onMap, onUnmap }: ColumnMapperProps) {
  const { requiredFields, fileColumns, unknownHeaders, headerMappings } = parsedData;

  // Compute effective state for each required field (auto + user override)
  const effectiveFields = requiredFields.map(f => {
    const userCol = userMapping[f.canonical] ?? null;
    const found = f.found || Boolean(userCol);
    const mappedFrom = userCol ?? f.mappedFrom;
    return { ...f, found, mappedFrom, userOverridden: Boolean(userCol) };
  });

  const optionalMapped = headerMappings.filter(m =>
    m.recognized && !requiredFields.some(r => r.canonical === m.canonical)
  );

  return (
    <div className="space-y-3">
      {/* Required fields */}
      <div className="rounded-xl border border-border/50 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/20 border-b border-border/30">
          <Columns size={13} className="text-primary" />
          <span className="text-xs font-semibold">Required Column Mapping</span>
          <Badge variant="secondary" className={`text-[10px] ml-auto ${effectiveFields.every(f => f.found) ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-red-500/30 bg-red-500/10 text-red-400"}`}>
            {effectiveFields.filter(f => f.found).length} / {effectiveFields.length} mapped
          </Badge>
        </div>
        <div className="divide-y divide-border/20">
          {effectiveFields.map(field => (
            <div key={field.canonical} className={`flex items-center gap-3 px-4 py-2.5 ${!field.found ? "bg-red-500/[0.03]" : ""}`}>
              {/* Status icon */}
              <div className="shrink-0">
                {field.found ? (
                  <CheckCircle2 size={15} className={field.userOverridden ? "text-blue-400" : "text-emerald-400"} />
                ) : (
                  <AlertTriangle size={15} className="text-red-400" />
                )}
              </div>

              {/* Field name */}
              <div className="w-36 shrink-0">
                <div className="text-xs font-semibold text-foreground">{field.friendlyName}</div>
                <div className="text-[10px] text-muted-foreground/60 font-mono">{field.canonical}</div>
              </div>

              {/* Arrow */}
              <ArrowRight size={12} className="text-muted-foreground/30 shrink-0" />

              {/* Column selector */}
              <div className="flex-1 min-w-0">
                {field.found && !field.userOverridden ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-primary/80 truncate">{field.mappedFrom}</span>
                    <span className="text-[10px] text-emerald-400/70">auto-detected</span>
                    <button
                      type="button"
                      onClick={() => onMap(field.canonical, field.mappedFrom!)}
                      className="ml-auto text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors underline shrink-0"
                    >
                      override
                    </button>
                  </div>
                ) : (
                  <select
                    value={field.mappedFrom ?? ""}
                    onChange={e => {
                      const col = e.target.value;
                      if (!col) onUnmap(field.canonical);
                      else onMap(field.canonical, col);
                    }}
                    className={`w-full text-xs rounded-lg border px-2 py-1.5 bg-background font-mono transition-colors focus:outline-none focus:ring-1 ${
                      field.found
                        ? "border-blue-500/40 focus:ring-blue-500/30"
                        : "border-red-500/40 focus:ring-red-500/30"
                    }`}
                  >
                    <option value="">— select a column from your file —</option>
                    {fileColumns.map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Status badge */}
              <div className="shrink-0">
                {field.found ? (
                  <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${
                    field.userOverridden
                      ? "border-blue-500/30 bg-blue-500/10 text-blue-400"
                      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  }`}>
                    <CheckCircle2 size={9} />
                    {field.userOverridden ? "manually mapped" : "found"}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-400">
                    <AlertCircle size={9} /> missing
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Optional recognized columns */}
      {optionalMapped.length > 0 && (
        <div className="rounded-xl border border-border/40 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/10 border-b border-border/20">
            <Table2 size={13} className="text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground">Optional columns detected</span>
            <Badge variant="secondary" className="text-[10px] ml-auto">{optionalMapped.length}</Badge>
          </div>
          <div className="flex flex-wrap gap-1.5 p-3">
            {optionalMapped.map(m => (
              <span key={m.original} className="inline-flex items-center gap-1.5 text-[11px] font-mono px-2 py-1 rounded-lg border border-blue-500/20 bg-blue-500/5 text-blue-300/70">
                <CheckCircle2 size={9} className="text-blue-400" />
                {m.original}
                <ArrowRight size={8} className="opacity-40" />
                {m.canonical}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Unknown / unrecognized columns — strict mode flag */}
      {unknownHeaders.length > 0 && (
        <div className="rounded-xl border border-orange-500/20 bg-orange-500/[0.03] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-orange-500/15">
            <AlertTriangle size={13} className="text-orange-400 shrink-0" />
            <span className="text-xs font-semibold text-orange-300">
              {unknownHeaders.length} unrecognized column{unknownHeaders.length !== 1 ? "s" : ""} — will be ignored
            </span>
          </div>
          <div className="p-3 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {unknownHeaders.map(col => (
                <span key={col} className="text-[11px] font-mono px-2 py-0.5 rounded-full border border-orange-500/30 bg-orange-500/10 text-orange-300">
                  {col}
                </span>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground/60">
              These columns are not recognized. If they contain data you need, use the dropdowns above to map them to the correct field.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main import page ─────────────────────────────────────────────────────────
export default function AdminImport() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const { data: currentUser } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const isAdmin = currentUser?.role === "admin";
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [isXlsx, setIsXlsx] = useState(false);
  const [csvPreviewRows, setCsvPreviewRows] = useState<{ headers: string[]; rows: Record<string, string>[] } | null>(null);

  // Server-side header analysis (from parse-headers endpoint)
  const [parsedData, setParsedData] = useState<ParsedHeaders | null>(null);
  const [parsePending, setParsePending] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  // User manual column mapping: canonical → originalFileCol
  const [userMapping, setUserMapping] = useState<Record<string, string>>({});

  const [dryRun, setDryRun] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Compute effective required field state
  const effectiveRequiredFields = parsedData?.requiredFields.map(f => ({
    ...f,
    found: f.found || Boolean(userMapping[f.canonical]),
  })) ?? [];
  const stillMissing = effectiveRequiredFields.filter(f => !f.found);
  const canImport = parsedData !== null && stillMissing.length === 0;

  async function callParseHeaders(f: File) {
    setParsePending(true);
    setParseError(null);
    setParsedData(null);
    try {
      const token = await getToken();
      const formData = new FormData();
      formData.append("file", f);
      const res = await fetch("/api/admin/products/parse-headers", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        setParseError(`Server returned an unexpected response (HTTP ${res.status}). The server may be starting up — try again in a moment.`);
        return;
      }
      const data = await res.json();
      if (isAdmin) {
        setDebugEntries(prev => [{
          label: "Parse Headers",
          method: "POST",
          endpoint: "/api/admin/products/parse-headers",
          status: res.status,
          response: data,
          timestamp: new Date().toLocaleTimeString(),
        }, ...prev]);
      }
      if (!res.ok) {
        setParseError(data.error ?? `Could not analyze headers (${res.status})`);
        return;
      }
      setParsedData(data as ParsedHeaders);
    } catch {
      setParseError("Could not reach the server — check your connection and try again.");
    } finally {
      setParsePending(false);
    }
  }

  function handleFile(f: File) {
    setResult(null);
    setError(null);
    setFile(f);
    setUserMapping({});
    setParsedData(null);

    const xlsx = /\.(xlsx|xls)$/i.test(f.name);
    setIsXlsx(xlsx);

    if (!xlsx) {
      const reader = new FileReader();
      reader.onload = e => {
        const text = e.target?.result as string;
        const { rawHeaders, rows } = parseCsvPreview(text);
        setCsvPreviewRows({ headers: rawHeaders, rows });
      };
      reader.readAsText(f);
    } else {
      setCsvPreviewRows(null);
    }

    void callParseHeaders(f);
  }

  function handleMap(canonical: string, originalCol: string) {
    setUserMapping(prev => ({ ...prev, [canonical]: originalCol }));
  }

  function handleUnmap(canonical: string) {
    setUserMapping(prev => {
      const next = { ...prev };
      delete next[canonical];
      return next;
    });
  }

  async function handleImport() {
    if (!file) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const token = await getToken();
      const formData = new FormData();
      formData.append("file", file);

      // Invert UI mapping (canonical → originalCol) to server format (originalCol → canonical)
      const serverMapping: Record<string, string> = {};
      for (const [canonical, originalCol] of Object.entries(userMapping)) {
        serverMapping[originalCol] = canonical;
      }
      if (Object.keys(serverMapping).length > 0) {
        formData.append("userMapping", JSON.stringify(serverMapping));
      }

      const res = await fetch(`/api/admin/products/import?dryRun=${dryRun}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        setError(`Server returned an unexpected response (HTTP ${res.status}). The server may be restarting — please try again in a moment.`);
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        // If the server returns structured mapping info (e.g. still missing required)
        // update parsedData so the mapper reflects the server's view
        if (data.requiredFields && data.fileColumns) {
          setParsedData(prev => prev ? {
            ...prev,
            requiredFields: data.requiredFields,
            fileColumns: data.fileColumns,
            unknownHeaders: data.unknownHeaders ?? prev.unknownHeaders,
            missingRequired: data.missingRequired ?? prev.missingRequired,
          } : null);
        }
        if (isAdmin) {
          setDebugEntries(prev => [{
            label: dryRun ? "Dry Run Import (failed)" : "Live Import (failed)",
            method: "POST",
            endpoint: `/api/admin/products/import?dryRun=${dryRun}`,
            status: res.status,
            response: data,
            timestamp: new Date().toLocaleTimeString(),
          }, ...prev]);
        }
        setError(data.error ?? `Import failed (${res.status})`);
        return;
      }
      if (isAdmin) {
        setDebugEntries(prev => [{
          label: dryRun ? "Dry Run Import" : "Live Import",
          method: "POST",
          endpoint: `/api/admin/products/import?dryRun=${dryRun}`,
          status: res.status,
          response: data,
          timestamp: new Date().toLocaleTimeString(),
        }, ...prev]);
      }
      setResult(data);
      if (!dryRun && data.inserted > 0) {
        queryClient.invalidateQueries({ queryKey: ["listCatalogItems"] });
      }
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setImporting(false);
    }
  }

  function downloadTemplate() {
    const sampleRow = [
      "29.99", "https://example.com/menu-img.jpg", "Midnight Recovery Complex",
      "Advanced cellular recovery blend", "Dermatology", "true", "ALV-001", "false",
      "24.99", "", "Velvet Restore Set", "https://example.com/merchant-img.jpg",
      "Luxurious overnight treatment", "Skin Care", "true", "MRC-001",
      "2024-01-15", "2024-03-20", "user_123", "admin", "MRC-Lab",
    ];
    const csv = [TEMPLATE_HEADERS.join(","), sampleRow.join(",")].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "menu_import_template.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  function reset() {
    setFile(null);
    setIsXlsx(false);
    setCsvPreviewRows(null);
    setParsedData(null);
    setUserMapping({});
    setResult(null);
    setError(null);
    setParseError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Upload size={18} className="text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Import Menu</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Sync from WooCommerce or upload a CSV / Excel file to upsert products</p>
        </div>
      </div>

      {/* WooCommerce Sync */}
      <WooCommerceSync />

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 border-t border-border/30" />
        <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest">Or import via file</span>
        <div className="flex-1 border-t border-border/30" />
      </div>

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" className="gap-2 rounded-xl" onClick={downloadTemplate}>
          <Download size={14} /> Download Template CSV
        </Button>

        <button
          type="button"
          onClick={() => setDryRun(d => !d)}
          className={`flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-xl border transition-all ${
            dryRun
              ? "border-violet-500/50 bg-violet-500/10 text-violet-300"
              : "border-border/50 bg-muted/20 text-muted-foreground hover:text-foreground"
          }`}
        >
          <FlaskConical size={13} />
          {dryRun ? "Dry Run ON" : "Dry Run OFF"}
        </button>
        {dryRun && <span className="text-[11px] text-violet-300/70">Validation only — no rows will be written</span>}

        {file && (
          <Button variant="ghost" size="sm" className="gap-2 rounded-xl text-muted-foreground ml-auto" onClick={reset}>
            <RotateCcw size={13} /> Start Over
          </Button>
        )}
      </div>

      {/* Upload zone (no file selected) */}
      {!file && (
        <div className="space-y-3">
          <div
            className="border-2 border-dashed border-border/50 rounded-2xl p-12 text-center cursor-pointer hover:border-primary/40 hover:bg-primary/[0.02] transition-all"
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          >
            <FileText size={36} className="mx-auto mb-4 text-muted-foreground/40" />
            <p className="font-semibold text-sm mb-1">Drop your CSV or Excel file here, or click to browse</p>
            <p className="text-xs text-muted-foreground mb-4">Accepts .csv and .xlsx · Max 10 MB</p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {REQUIRED_COLS.map(c => (
                <span key={c.canonical} className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-300">
                  <span className="w-1 h-1 rounded-full bg-red-400 shrink-0" />
                  {c.friendly}
                </span>
              ))}
            </div>
            <input
              ref={fileRef} type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
          </div>
          <ExpectedColumnsRef />
        </div>
      )}

      {/* File selected — header analysis + mapper */}
      {file && !result && (
        <div className="space-y-4">
          {/* File info bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <FileText size={15} className="text-primary shrink-0" />
            <span className="text-sm font-semibold">{file.name}</span>
            <Badge variant="secondary" className="text-[10px]">
              {isXlsx ? "Excel" : csvPreviewRows ? `${csvPreviewRows.rows.length} preview rows` : "CSV"}
            </Badge>
            {dryRun && <Badge className="text-[10px] bg-violet-500/20 text-violet-300 border-violet-500/30">DRY RUN</Badge>}
            {parsePending && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Loader2 size={11} className="animate-spin" /> Analyzing headers...
              </span>
            )}
            {parsedData && !parsePending && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-400/80">
                <CheckCircle2 size={11} /> Headers analyzed
              </span>
            )}
          </div>

          {/* Parse error */}
          {parseError && (
            <div className="flex items-start gap-3 p-3 rounded-xl border border-orange-500/30 bg-orange-500/10 text-orange-400 text-xs">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <div className="flex-1">
                <span className="font-semibold">Could not analyze headers: </span>{parseError}
                <div className="mt-1 opacity-70">You can retry the analysis, or import anyway — the server will validate headers on submit.</div>
              </div>
              <button
                type="button"
                onClick={() => file && void callParseHeaders(file)}
                disabled={parsePending}
                className="shrink-0 flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-orange-500/40 bg-orange-500/10 hover:bg-orange-500/20 transition-colors"
              >
                {parsePending ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                Retry
              </button>
            </div>
          )}

          {/* Column mapper (once parse-headers responds) */}
          {parsedData && (
            <ColumnMapper
              parsedData={parsedData}
              userMapping={userMapping}
              onMap={handleMap}
              onUnmap={handleUnmap}
            />
          )}

          {/* XLSX — no client-side preview */}
          {isXlsx && !parsedData && !parsePending && !parseError && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-blue-500/20 bg-blue-500/5 text-blue-300/70 text-xs">
              <FileText size={13} className="shrink-0" />
              Excel file ready — header mapping will appear after analysis
            </div>
          )}

          {/* CSV data preview (first 5 rows, required cols only) */}
          {!isXlsx && csvPreviewRows && csvPreviewRows.rows.length > 0 && parsedData && (
            <div className="rounded-xl border border-border/50 overflow-auto">
              <div className="flex items-center gap-2 px-4 py-2 bg-muted/20 border-b border-border/30">
                <Table2 size={12} className="text-muted-foreground" />
                <span className="text-xs font-semibold text-muted-foreground">Data preview (first {csvPreviewRows.rows.length} rows)</span>
              </div>
              <table className="w-full text-xs min-w-max">
                <thead className="bg-muted/30">
                  <tr>
                    {parsedData.requiredFields
                      .filter(f => f.found || userMapping[f.canonical])
                      .map(f => (
                        <th key={f.canonical} className="px-3 py-2 text-left font-semibold text-muted-foreground uppercase tracking-widest whitespace-nowrap">
                          {f.friendlyName}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {csvPreviewRows.rows.map((row, i) => (
                    <tr key={i} className="hover:bg-muted/10 transition-colors">
                      {parsedData.requiredFields
                        .filter(f => f.found || userMapping[f.canonical])
                        .map(f => {
                          const col = userMapping[f.canonical] ?? f.mappedFrom ?? "";
                          return (
                            <td key={f.canonical} className="px-3 py-2 truncate max-w-[200px]" title={row[col]}>
                              {row[col] || <span className="text-muted-foreground/40">—</span>}
                            </td>
                          );
                        })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Still-missing warning */}
          {stillMissing.length > 0 && parsedData && (
            <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-xs">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">
                  {stillMissing.length} required column{stillMissing.length !== 1 ? "s" : ""} still unmapped:{" "}
                </span>
                {stillMissing.map(f => f.friendlyName).join(", ")}
                <div className="mt-1 opacity-70">Use the dropdowns above to map a column from your file to each required field.</div>
              </div>
            </div>
          )}

          {/* Import button */}
          <div className="flex items-center gap-3">
            <Button
              onClick={handleImport}
              disabled={importing || (parsedData !== null && !canImport && !dryRun)}
              className="gap-2 rounded-xl"
              style={(!importing && (canImport || dryRun)) ? {
                background: dryRun ? undefined : "linear-gradient(135deg, #7c3aed, #4f46e5)",
                color: "#fff",
              } : {}}
            >
              {importing ? (
                <><Loader2 size={14} className="animate-spin" /> {dryRun ? "Validating..." : "Importing..."}</>
              ) : dryRun ? (
                <><FlaskConical size={14} /> Run Dry Validation</>
              ) : (
                <><Upload size={14} /> Run Import</>
              )}
            </Button>
            {!parsedData && !parsePending && (
              <span className="text-[11px] text-muted-foreground">Import will validate headers server-side</span>
            )}
          </div>
        </div>
      )}

      {/* Import error */}
      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          <ResultCards result={result} />
          <div className="flex gap-3">
            {result.dryRun && (
              <Button
                onClick={() => { setDryRun(false); setResult(null); }}
                className="gap-2 rounded-xl"
                style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)", color: "#fff" }}
              >
                <Upload size={13} /> Run Live Import
              </Button>
            )}
            <Button variant="outline" size="sm" className="gap-2 rounded-xl" onClick={reset}>
              <RotateCcw size={13} /> Import Another File
            </Button>
          </div>
        </div>
      )}

      {/* Admin debug panel */}
      {isAdmin && debugEntries.length > 0 && (
        <DebugPanel entries={debugEntries} onClear={() => setDebugEntries([])} />
      )}
    </div>
  );
}
