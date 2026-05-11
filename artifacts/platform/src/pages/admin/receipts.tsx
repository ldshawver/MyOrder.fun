import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Loader2, Save, RefreshCw, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ReceiptSettings = {
  brandName: string;
  footerMessage: string;
  paperWidth: string;
  includeLogo: boolean;
  includeOperatorName: boolean;
  showDiscreetNotice: boolean;
  autoPrintReceipts: boolean;
};

const DEFAULTS: ReceiptSettings = {
  brandName: "",
  footerMessage: "",
  paperWidth: "80mm",
  includeLogo: true,
  includeOperatorName: true,
  showDiscreetNotice: false,
  autoPrintReceipts: false,
};

export default function AdminReceipts() {
  const { getToken } = useAuth();
  const [settings, setSettings] = useState<ReceiptSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/print/settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Failed to load settings (HTTP ${res.status}): ${txt.slice(0, 200)}`);
      }
      const data = await res.json();
      const s = data.settings ?? {};
      setSettings({
        brandName: s.brandName ?? "",
        footerMessage: s.footerMessage ?? "",
        paperWidth: s.paperWidth ?? "80mm",
        includeLogo: s.includeLogo !== false,
        includeOperatorName: s.includeOperatorName !== false,
        showDiscreetNotice: Boolean(s.showDiscreetNotice),
        autoPrintReceipts: Boolean(s.autoPrintReceipts),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/print/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Save failed (HTTP ${res.status}): ${txt.slice(0, 200)}`);
      }
      const data = await res.json();
      const s = data.settings ?? {};
      setSettings(prev => ({
        ...prev,
        brandName: s.brandName ?? prev.brandName,
        footerMessage: s.footerMessage ?? prev.footerMessage,
        paperWidth: s.paperWidth ?? prev.paperWidth,
        includeLogo: s.includeLogo !== false,
        includeOperatorName: s.includeOperatorName !== false,
        showDiscreetNotice: Boolean(s.showDiscreetNotice),
        autoPrintReceipts: Boolean(s.autoPrintReceipts),
      }));
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2500);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function generatePreview() {
    setPreviewing(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/print/preview/receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Preview failed (HTTP ${res.status}): ${txt.slice(0, 200)}`);
      }
      setPreview(await res.text());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  function update<K extends keyof ReceiptSettings>(key: K, value: ReceiptSettings[K]) {
    setSettings(prev => ({ ...prev, [key]: value }));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6" data-testid="page-admin-receipts">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Receipt Templates</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Edit the brand name, footer message, paper width, and visibility flags used on every printed receipt.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {savedAt && <span className="text-xs text-green-400">Saved</span>}
          <Button onClick={load} variant="outline" size="sm" className="gap-1.5 rounded-xl" data-testid="button-receipts-reload">
            <RefreshCw size={12} /> Reload
          </Button>
          <Button onClick={save} disabled={saving} size="sm" className="gap-1.5 rounded-xl" data-testid="button-receipts-save">
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 p-3 text-sm" data-testid="text-receipts-error">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border/40 bg-card/30 p-5 space-y-4">
        <div>
          <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Brand name (header)</label>
          <Input
            value={settings.brandName}
            onChange={e => update("brandName", e.target.value)}
            placeholder="e.g. Alavont"
            data-testid="input-receipt-brand"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Footer message</label>
          <Input
            value={settings.footerMessage}
            onChange={e => update("footerMessage", e.target.value)}
            placeholder="e.g. Thank you for your order!"
            data-testid="input-receipt-footer"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Paper width</label>
          <select
            value={settings.paperWidth}
            onChange={e => update("paperWidth", e.target.value)}
            className="w-full h-10 rounded-lg bg-background/60 border border-border/40 px-3 text-sm"
            data-testid="select-receipt-paper-width"
          >
            <option value="58mm">58mm</option>
            <option value="80mm">80mm</option>
          </select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
          <ToggleRow label="Include logo" checked={settings.includeLogo}
            onChange={v => update("includeLogo", v)} testId="toggle-receipt-logo" />
          <ToggleRow label="Show operator name" checked={settings.includeOperatorName}
            onChange={v => update("includeOperatorName", v)} testId="toggle-receipt-operator" />
          <ToggleRow label="Discreet packaging notice" checked={settings.showDiscreetNotice}
            onChange={v => update("showDiscreetNotice", v)} testId="toggle-receipt-discreet" />
          <ToggleRow label="Auto-print receipts on payment" checked={settings.autoPrintReceipts}
            onChange={v => update("autoPrintReceipts", v)} testId="toggle-receipt-autoprint" />
        </div>
      </div>

      <div className="rounded-xl border border-border/40 bg-card/30 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Preview</div>
            <div className="text-xs text-muted-foreground">Renders a sample receipt using the current saved settings.</div>
          </div>
          <Button onClick={generatePreview} disabled={previewing} variant="outline" size="sm" className="gap-1.5 rounded-xl" data-testid="button-receipts-preview">
            {previewing ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
            {previewing ? "Rendering..." : "Render preview"}
          </Button>
        </div>
        {preview && (
          <pre
            className="text-xs font-mono bg-background/80 border border-border/40 rounded-lg p-4 whitespace-pre overflow-x-auto"
            data-testid="text-receipts-preview"
          >{preview}</pre>
        )}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <label className="flex items-center justify-between rounded-lg border border-border/40 bg-background/60 px-3 py-2.5 cursor-pointer">
      <span className="text-sm">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="h-4 w-4 accent-primary"
        data-testid={testId}
      />
    </label>
  );
}
