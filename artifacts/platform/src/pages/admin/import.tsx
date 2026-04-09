import { useState, useRef } from "react";
import {
  Upload, Download, FileText, CheckCircle2, AlertCircle,
  RotateCcw, ChevronRight, RefreshCw, ShoppingBag, Eye, EyeOff,
  FlaskConical, ArrowRight, Table2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAuth } from "@clerk/react";

// ─── Canonical headers (must match backend) ───────────────────────────────────
const CANONICAL_HEADERS = [
  "regular_price", "alavont_image_url", "alavont_name", "alavont_description",
  "alavont_category", "alavont_in_stock", "alavont_is_upsell", "alavont_id",
  "alavont_created_date", "alavont_updated_date", "alavont_created_by_id",
  "alavont_created_by", "alavont_is_sample", "homie_price",
  "lucifer_cruz_name", "lucifer_cruz_image_url", "lucifer_cruz_description",
  "lucifer_cruz_category", "lab_name",
];

const REQUIRED_COLS = ["regular_price", "alavont_name", "alavont_category", "lucifer_cruz_name", "lab_name"];

// ─── Types ────────────────────────────────────────────────────────────────────
type HeaderMapping = { original: string; canonical: string; recognized: boolean };

type ImportResult = {
  dryRun: boolean;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
  total: number;
  headerMappings?: HeaderMapping[];
};

type PreviewData = {
  rawHeaders: string[];
  rows: Record<string, string>[];
  isXlsx: boolean;
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

// Client-side header normalizer (mirrors backend logic for preview only)
function clientNormalize(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const norm = lower.replace(/[\s\-]+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return CANONICAL_HEADERS.includes(norm) ? norm : norm;
}

const CANONICAL_SET = new Set(CANONICAL_HEADERS);

function clientRecognized(raw: string): boolean {
  const norm = clientNormalize(raw);
  return CANONICAL_SET.has(norm);
}

// ─── WooCommerce Sync ─────────────────────────────────────────────────────────
const WC_STORE_URL = "https://lucifercruz.com";

function WooCommerceSync() {
  const { getToken } = useAuth();
  const [storeUrl, setStoreUrl] = useState(WC_STORE_URL);
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSync() {
    if (!consumerKey || !consumerSecret) { setError("Both Consumer Key and Consumer Secret are required."); return; }
    setSyncing(true); setError(null); setResult(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/woocommerce/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ storeUrl, consumerKey, consumerSecret }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Sync failed"); return; }
      setResult(data);
    } catch (e: any) {
      setError(e?.message ?? "Network error");
    } finally { setSyncing(false); }
  }

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
          <div className="text-xs text-muted-foreground">Pull all published products directly from your store</div>
        </div>
        <a href="https://lucifercruz.com/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys"
          target="_blank" rel="noopener noreferrer"
          className="text-[11px] font-semibold px-3 py-1.5 rounded-lg border transition-all"
          style={{ borderColor: "rgba(220,20,60,0.3)", color: "#DC143C" }}>
          Get API Keys ↗
        </a>
      </div>
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Store URL</label>
            <Input value={storeUrl} onChange={e => setStoreUrl(e.target.value)} placeholder="https://lucifercruz.com" className="h-9 text-sm rounded-xl bg-background/50" />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Consumer Key</label>
            <Input value={consumerKey} onChange={e => setConsumerKey(e.target.value)} placeholder="ck_xxxxxxxxxxxxxxxxxxxx" className="h-9 text-sm rounded-xl bg-background/50 font-mono text-xs" />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Consumer Secret</label>
            <div className="relative">
              <Input type={showSecret ? "text" : "password"} value={consumerSecret} onChange={e => setConsumerSecret(e.target.value)}
                placeholder="cs_xxxxxxxxxxxxxxxxxxxx" className="h-9 text-sm rounded-xl bg-background/50 font-mono text-xs pr-9" />
              <button type="button" onClick={() => setShowSecret(s => !s)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground leading-relaxed bg-muted/20 rounded-xl p-3">
          <strong>How to get your keys:</strong> WooCommerce → Settings → Advanced → REST API → Add Key. Permissions: <strong>Read</strong>.
        </div>
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span className="text-xs">{error}</span>
          </div>
        )}
        {result && !error && <ResultCards result={result} />}
        <Button onClick={handleSync} disabled={syncing || !consumerKey || !consumerSecret} className="gap-2 rounded-xl w-full sm:w-auto"
          style={(!syncing && consumerKey && consumerSecret) ? { background: "linear-gradient(135deg, #DC143C, #8B0000)", color: "#fff" } : {}}>
          {syncing ? <><RefreshCw size={14} className="animate-spin" /> Syncing from WooCommerce...</> : <><RefreshCw size={14} /> Sync from WooCommerce</>}
        </Button>
      </div>
    </div>
  );
}

// ─── Result cards component ───────────────────────────────────────────────────
function ResultCards({ result }: { result: ImportResult }) {
  const stats = [
    { label: "Inserted", value: result.inserted, color: "#10b981" },
    { label: "Updated", value: result.updated, color: "#3b82f6" },
    { label: "Skipped", value: result.skipped, color: "#f59e0b" },
    { label: "Failed", value: result.failed ?? 0, color: "#ef4444" },
    { label: "Total", value: result.total, color: "#6b7280" },
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

// ─── Header mapping table ─────────────────────────────────────────────────────
function HeaderMappingTable({ mappings }: { mappings: HeaderMapping[] }) {
  return (
    <div className="rounded-xl border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/20 border-b border-border/30">
        <Table2 size={13} className="text-primary" />
        <span className="text-xs font-semibold">Header Mapping</span>
        <Badge variant="secondary" className="text-[10px] ml-auto">
          {mappings.filter(m => m.recognized).length} / {mappings.length} recognized
        </Badge>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/10">
            <tr>
              <th className="px-3 py-2 text-left text-muted-foreground font-semibold uppercase tracking-widest">Your Column</th>
              <th className="px-3 py-2 text-center text-muted-foreground font-semibold uppercase tracking-widest w-8"></th>
              <th className="px-3 py-2 text-left text-muted-foreground font-semibold uppercase tracking-widest">Mapped To</th>
              <th className="px-3 py-2 text-left text-muted-foreground font-semibold uppercase tracking-widest">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/20">
            {mappings.map((m, i) => {
              const isRequired = REQUIRED_COLS.includes(m.canonical);
              return (
                <tr key={i} className="hover:bg-muted/10 transition-colors">
                  <td className="px-3 py-2 font-mono text-foreground/80">{m.original}</td>
                  <td className="px-3 py-2 text-center text-muted-foreground/50"><ArrowRight size={10} /></td>
                  <td className="px-3 py-2 font-mono text-primary/80">{m.canonical}</td>
                  <td className="px-3 py-2">
                    {m.recognized ? (
                      <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${
                        isRequired
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                          : "border-blue-500/30 bg-blue-500/10 text-blue-400"
                      }`}>
                        <CheckCircle2 size={9} />
                        {isRequired ? "required" : "recognized"}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-orange-500/30 bg-orange-500/10 text-orange-400">
                        <AlertCircle size={9} /> unknown — will be ignored
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main import page ─────────────────────────────────────────────────────────
export default function AdminImport() {
  const { getToken } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleFile(f: File) {
    setResult(null); setError(null); setFile(f);
    const isXlsx = /\.(xlsx|xls)$/i.test(f.name);
    if (isXlsx) {
      setPreview({ rawHeaders: [], rows: [], isXlsx: true });
    } else {
      const reader = new FileReader();
      reader.onload = e => {
        const text = e.target?.result as string;
        const { rawHeaders, rows } = parseCsvPreview(text);
        setPreview({ rawHeaders, rows, isXlsx: false });
      };
      reader.readAsText(f);
    }
  }

  async function handleImport() {
    if (!file) return;
    setImporting(true); setError(null); setResult(null);
    try {
      const token = await getToken();
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/admin/products/import?dryRun=${dryRun}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Import failed"); return; }
      setResult(data);
    } catch (e: any) {
      setError(e?.message ?? "Network error");
    } finally { setImporting(false); }
  }

  function downloadTemplate() {
    const sampleRow = [
      "29.99", "https://example.com/img.jpg", "Midnight Recovery Complex",
      "Advanced cellular recovery blend", "Dermatology", "true", "false",
      "ALV-001", "2025-01-01", "2025-06-01", "u001", "Dr. Adams", "false",
      "24.99", "Velvet Restore Set", "https://example.com/lc.jpg",
      "Luxurious overnight treatment", "Skin Care", "MRC-Lab",
    ];
    const csv = [CANONICAL_HEADERS.join(","), sampleRow.join(",")].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "menu_import_template.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  function reset() {
    setFile(null); setPreview(null); setResult(null); setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  // Build client-side header status from preview (before server response)
  const clientMappings: HeaderMapping[] = preview?.rawHeaders.map(h => ({
    original: h,
    canonical: clientNormalize(h),
    recognized: clientRecognized(h),
  })) ?? [];

  const missingRequired = preview && !preview.isXlsx
    ? REQUIRED_COLS.filter(c => !clientMappings.some(m => m.canonical === c))
    : [];

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
          <Download size={14} />
          Download Template CSV
        </Button>

        {/* Dry-run toggle */}
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
        {dryRun && (
          <span className="text-[11px] text-violet-300/70">Validation only — no rows will be written</span>
        )}

        {file && (
          <Button variant="ghost" size="sm" className="gap-2 rounded-xl text-muted-foreground ml-auto" onClick={reset}>
            <RotateCcw size={13} /> Start Over
          </Button>
        )}
      </div>

      {/* Upload zone */}
      {!file && (
        <div
          className="border-2 border-dashed border-border/50 rounded-2xl p-12 text-center cursor-pointer hover:border-primary/40 hover:bg-primary/[0.02] transition-all"
          onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        >
          <FileText size={36} className="mx-auto mb-4 text-muted-foreground/40" />
          <p className="font-semibold text-sm mb-1">Drop your CSV or Excel file here, or click to browse</p>
          <p className="text-xs text-muted-foreground">Accepts .csv and .xlsx · Max 10 MB · Must include required columns</p>
          <div className="flex flex-wrap justify-center gap-1.5 mt-4">
            {REQUIRED_COLS.map(c => (
              <span key={c} className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-primary/20 bg-primary/5 text-primary/60">{c}</span>
            ))}
          </div>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        </div>
      )}

      {/* File selected — preview */}
      {file && preview && !result && (
        <div className="space-y-4">
          {/* File info */}
          <div className="flex items-center gap-2">
            <FileText size={15} className="text-primary" />
            <span className="text-sm font-semibold">{file.name}</span>
            <Badge variant="secondary" className="text-[10px]">
              {preview.isXlsx ? "Excel" : `${preview.rows.length} preview rows`}
            </Badge>
            {dryRun && <Badge className="text-[10px] bg-violet-500/20 text-violet-300 border-violet-500/30">DRY RUN</Badge>}
          </div>

          {/* Client-side header mapping preview (CSV only) */}
          {!preview.isXlsx && clientMappings.length > 0 && (
            <HeaderMappingTable mappings={clientMappings} />
          )}

          {/* XLSX — no client-side preview available */}
          {preview.isXlsx && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-blue-500/20 bg-blue-500/5 text-blue-300/70 text-xs">
              <FileText size={13} className="shrink-0" />
              Excel file ready — header mapping will be shown after import
            </div>
          )}

          {/* Missing required columns warning */}
          {missingRequired.length > 0 && (
            <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-xs">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">Missing required columns: </span>
                {missingRequired.join(", ")}
                <div className="mt-1 opacity-70">Download the template to see the correct column names.</div>
              </div>
            </div>
          )}

          {/* Data preview table (CSV) */}
          {!preview.isXlsx && preview.rows.length > 0 && (
            <div className="rounded-xl border border-border/50 overflow-auto">
              <table className="w-full text-xs min-w-max">
                <thead className="bg-muted/30">
                  <tr>
                    {REQUIRED_COLS.filter(c => clientMappings.some(m => m.canonical === c)).map(h => (
                      <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground uppercase tracking-widest whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {preview.rows.map((row, i) => {
                    const byCanonical: Record<string, string> = {};
                    clientMappings.forEach(m => { byCanonical[m.canonical] = row[m.original] ?? ""; });
                    return (
                      <tr key={i} className="hover:bg-muted/10 transition-colors">
                        {REQUIRED_COLS.filter(c => clientMappings.some(m => m.canonical === c)).map(col => (
                          <td key={col} className="px-3 py-2 truncate max-w-[200px]" title={byCanonical[col]}>
                            {byCanonical[col] || <span className="text-muted-foreground/40">—</span>}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Import button */}
          <Button
            onClick={handleImport}
            disabled={importing || (!preview.isXlsx && missingRequired.length > 0 && !dryRun)}
            className="gap-2 rounded-xl"
            style={{ background: dryRun ? undefined : "linear-gradient(135deg, #7c3aed, #4f46e5)", color: "#fff" }}
          >
            {importing ? (
              <><RotateCcw size={14} className="animate-spin" /> {dryRun ? "Validating..." : "Importing..."}</>
            ) : dryRun ? (
              <><FlaskConical size={14} /> Run Dry Validation</>
            ) : (
              <><Upload size={14} /> Run Import</>
            )}
          </Button>
        </div>
      )}

      {/* Error */}
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

          {/* Server-side header mapping (after import) */}
          {result.headerMappings && result.headerMappings.length > 0 && (
            <HeaderMappingTable mappings={result.headerMappings} />
          )}

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
              <Upload size={13} /> Import Another File
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
