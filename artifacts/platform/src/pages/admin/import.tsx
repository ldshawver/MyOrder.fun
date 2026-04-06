import { useState, useRef } from "react";
import { Upload, Download, FileText, CheckCircle2, AlertCircle, RotateCcw, ChevronRight, RefreshCw, ShoppingBag, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAuth } from "@clerk/react";

const SAMPLE_HEADERS = "regular_price,homie_price,alavont_image_url,alavont_name,alavont_description,alavont_category,alavont_in_stock,alavont_is_upsell,alavont_id,alavont_created_date,alavont_updated_date,alavont_created_by_id,alavont_created_by,alavont_is_sample,lucifer_cruz_name,lucifer_cruz_image_url,lucifer_cruz_description,receipt_name,label_name,lab_name";

const SAMPLE_ROW = "29.99,24.99,https://example.com/img1.jpg,Midnight Recovery Complex,Advanced cellular recovery,Dermatology,true,false,ALV-001,2025-01-01,2025-06-01,u001,Dr. Adams,false,Velvet Restore Set,https://example.com/lc1.jpg,Luxurious overnight skin treatment,Velvet Restore Set,VRS-001,MRC-Recovery";

function downloadSampleCSV() {
  const content = [SAMPLE_HEADERS, SAMPLE_ROW].join("\n");
  const blob = new Blob([content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "menu_import_sample.csv";
  a.click();
  URL.revokeObjectURL(url);
}

type ImportResult = {
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
  total: number;
};

type PreviewRow = Record<string, string>;

function parseCSVPreview(text: string): { headers: string[]; rows: PreviewRow[] } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 1) return { headers: [], rows: [] };
  const parseLine = (line: string) => {
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
  const headers = parseLine(lines[0]).map(h => h.toLowerCase().trim());
  const rows = lines.slice(1, 6).map(line => {
    const vals = parseLine(line);
    const obj: PreviewRow = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ""; });
    return obj;
  });
  return { headers, rows };
}

const KEY_COLS = ["alavont_name", "lucifer_cruz_name", "regular_price", "alavont_category", "lab_name"];
const WC_STORE_URL = "https://lucifercruz.com";

type WcSyncResult = {
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
  total: number;
};

function WooCommerceSync() {
  const { getToken } = useAuth();
  const [storeUrl, setStoreUrl] = useState(WC_STORE_URL);
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<WcSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSync() {
    if (!consumerKey || !consumerSecret) {
      setError("Both Consumer Key and Consumer Secret are required.");
      return;
    }
    setSyncing(true);
    setError(null);
    setResult(null);
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
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border/50 bg-card/50 overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-5 py-4 border-b border-border/30"
        style={{ background: "linear-gradient(135deg, rgba(220,20,60,0.08), rgba(139,0,0,0.04))" }}
      >
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: "linear-gradient(135deg, #DC143C, #8B0000)" }}
        >
          <ShoppingBag size={16} className="text-white" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold">Lucifer Cruz · WooCommerce Sync</div>
          <div className="text-xs text-muted-foreground">Pull all published products directly from your store</div>
        </div>
        <a
          href="https://lucifercruz.com/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] font-semibold px-3 py-1.5 rounded-lg border transition-all"
          style={{ borderColor: "rgba(220,20,60,0.3)", color: "#DC143C" }}
        >
          Get API Keys ↗
        </a>
      </div>

      {/* Form */}
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Store URL</label>
            <Input
              value={storeUrl}
              onChange={e => setStoreUrl(e.target.value)}
              placeholder="https://lucifercruz.com"
              className="h-9 text-sm rounded-xl bg-background/50"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Consumer Key</label>
            <Input
              value={consumerKey}
              onChange={e => setConsumerKey(e.target.value)}
              placeholder="ck_xxxxxxxxxxxxxxxxxxxx"
              className="h-9 text-sm rounded-xl bg-background/50 font-mono text-xs"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Consumer Secret</label>
            <div className="relative">
              <Input
                type={showSecret ? "text" : "password"}
                value={consumerSecret}
                onChange={e => setConsumerSecret(e.target.value)}
                placeholder="cs_xxxxxxxxxxxxxxxxxxxx"
                className="h-9 text-sm rounded-xl bg-background/50 font-mono text-xs pr-9"
              />
              <button
                type="button"
                onClick={() => setShowSecret(s => !s)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          </div>
        </div>

        <div className="text-[11px] text-muted-foreground leading-relaxed bg-muted/20 rounded-xl p-3">
          <strong>How to get your keys:</strong> In WooCommerce admin → WooCommerce → Settings → Advanced → REST API → Add Key.
          Set permissions to <strong>Read</strong>. Copy the Consumer Key and Consumer Secret before closing the page.
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span className="text-xs">{error}</span>
          </div>
        )}

        {result && !error && (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: "Inserted", value: result.inserted, color: "#10b981" },
                { label: "Updated", value: result.updated, color: "#3b82f6" },
                { label: "Skipped", value: result.skipped, color: "#f59e0b" },
                { label: "Total", value: result.total, color: "#6b7280" },
              ].map(({ label, value, color }) => (
                <div key={label} className="glass-card rounded-xl p-3 border border-border/40 text-center">
                  <div className="text-xl font-bold" style={{ color }}>{value}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
                </div>
              ))}
            </div>
            {result.errors.length > 0 && (
              <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/[0.05] p-3 max-h-32 overflow-y-auto space-y-1">
                {result.errors.map((e, i) => (
                  <div key={i} className="text-[11px] text-yellow-300/70 font-mono flex gap-1.5">
                    <ChevronRight size={10} className="shrink-0 mt-0.5" />{e}
                  </div>
                ))}
              </div>
            )}
            {result.errors.length === 0 && (
              <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold">
                <CheckCircle2 size={13} /> Sync complete — all {result.total} products imported successfully
              </div>
            )}
          </div>
        )}

        <Button
          onClick={handleSync}
          disabled={syncing || !consumerKey || !consumerSecret}
          className="gap-2 rounded-xl w-full sm:w-auto"
          style={(!syncing && consumerKey && consumerSecret)
            ? { background: "linear-gradient(135deg, #DC143C, #8B0000)", color: "#fff" }
            : {}}
        >
          {syncing ? (
            <><RefreshCw size={14} className="animate-spin" /> Syncing from WooCommerce...</>
          ) : (
            <><RefreshCw size={14} /> Sync from WooCommerce</>
          )}
        </Button>
      </div>
    </div>
  );
}

export default function AdminImport() {
  const { getToken } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<{ headers: string[]; rows: PreviewRow[] } | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleFile(file: File) {
    setResult(null);
    setError(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      setCsvText(text);
      setPreview(parseCSVPreview(text));
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!csvText) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/products/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ csvContent: csvText }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Import failed"); return; }
      setResult(data);
    } catch (e: any) {
      setError(e?.message ?? "Network error");
    } finally {
      setImporting(false);
    }
  }

  function reset() {
    setCsvText(null);
    setFileName("");
    setPreview(null);
    setResult(null);
    setError(null);
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
          <p className="text-xs text-muted-foreground mt-0.5">Sync from WooCommerce or upload a CSV to upsert products</p>
        </div>
      </div>

      {/* WooCommerce Sync */}
      <WooCommerceSync />

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 border-t border-border/30" />
        <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-widest">Or import via CSV</span>
        <div className="flex-1 border-t border-border/30" />
      </div>

      {/* Action row */}
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          size="sm"
          className="gap-2 rounded-xl"
          onClick={downloadSampleCSV}
        >
          <Download size={14} />
          Download Sample CSV
        </Button>
        {csvText && (
          <Button variant="ghost" size="sm" className="gap-2 rounded-xl text-muted-foreground" onClick={reset}>
            <RotateCcw size={13} />
            Start Over
          </Button>
        )}
      </div>

      {/* Upload zone */}
      {!csvText && (
        <div
          className="border-2 border-dashed border-border/50 rounded-2xl p-12 text-center cursor-pointer hover:border-primary/40 hover:bg-primary/[0.02] transition-all"
          onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        >
          <FileText size={36} className="mx-auto mb-4 text-muted-foreground/40" />
          <p className="font-semibold text-sm mb-1">Drop your CSV here or click to browse</p>
          <p className="text-xs text-muted-foreground">Must include all required columns (alavont_id, alavont_name, lucifer_cruz_name, regular_price, etc.)</p>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        </div>
      )}

      {/* Preview */}
      {preview && csvText && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText size={15} className="text-primary" />
              <span className="text-sm font-semibold">{fileName}</span>
              <Badge variant="secondary" className="text-[10px]">{preview.rows.length} of {csvText.split("\n").filter(l => l.trim()).length - 1} rows shown</Badge>
            </div>
          </div>

          {/* Column check */}
          <div className="flex flex-wrap gap-2">
            {KEY_COLS.map(col => {
              const present = preview.headers.includes(col);
              return (
                <div key={col} className={`flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border ${present ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-red-500/30 bg-red-500/10 text-red-400"}`}>
                  {present ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
                  {col}
                </div>
              );
            })}
          </div>

          {/* Table preview */}
          <div className="rounded-xl border border-border/50 overflow-auto">
            <table className="w-full text-xs min-w-max">
              <thead className="bg-muted/30">
                <tr>
                  {KEY_COLS.filter(c => preview.headers.includes(c)).map(h => (
                    <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground uppercase tracking-widest whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {preview.rows.map((row, i) => (
                  <tr key={i} className="hover:bg-muted/10 transition-colors">
                    {KEY_COLS.filter(c => preview.headers.includes(c)).map(col => (
                      <td key={col} className="px-3 py-2 truncate max-w-[200px]" title={row[col]}>{row[col] || <span className="text-muted-foreground/40">—</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Import button */}
          {!result && (
            <Button
              onClick={handleImport}
              disabled={importing}
              className="gap-2 rounded-xl"
            >
              {importing ? (
                <><RotateCcw size={14} className="animate-spin" /> Importing...</>
              ) : (
                <><Upload size={14} /> Run Import</>
              )}
            </Button>
          )}
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Inserted", value: result.inserted, color: "emerald" },
              { label: "Updated", value: result.updated, color: "blue" },
              { label: "Skipped", value: result.skipped, color: "yellow" },
              { label: "Total Rows", value: result.total, color: "gray" },
            ].map(({ label, value, color }) => (
              <div key={label} className="glass-card rounded-xl p-4 border border-border/40">
                <div className={`text-2xl font-bold text-${color}-400`}>{value}</div>
                <div className="text-xs text-muted-foreground mt-1">{label}</div>
              </div>
            ))}
          </div>

          {result.errors.length > 0 && (
            <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/[0.05] p-4 space-y-2">
              <div className="flex items-center gap-2 text-yellow-400 font-semibold text-sm">
                <AlertCircle size={14} />
                {result.errors.length} row error{result.errors.length !== 1 ? "s" : ""}
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {result.errors.map((e, i) => (
                  <div key={i} className="text-xs text-yellow-300/70 font-mono flex items-center gap-2">
                    <ChevronRight size={10} className="shrink-0" />
                    {e}
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.errors.length === 0 && (
            <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
              <CheckCircle2 size={16} />
              Import completed successfully — no errors
            </div>
          )}

          <Button variant="outline" size="sm" className="gap-2 rounded-xl" onClick={reset}>
            <Upload size={13} />
            Import Another File
          </Button>
        </div>
      )}
    </div>
  );
}
