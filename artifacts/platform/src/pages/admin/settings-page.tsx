import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { Settings, Save, RefreshCw, CheckCircle2, Eye, EyeOff, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type AdminSettings = {
  menuImportEnabled: boolean;
  showOutOfStock: boolean;
  enabledProcessors: string[];
  checkoutConversionPreview: boolean;
  merchantImageEnabled: boolean;
  autoPrintOnPayment: boolean;
  receiptTemplateStyle: string;
  labelTemplateStyle: string;
  purgeMode: string;
  purgeDelayHours: number;
  keepAuditToken: boolean;
  keepFailedPaymentLogs: boolean;
  receiptLineNameMode: string;
  wcStoreUrl: string;
  wcConsumerKeySet: boolean;
  wcConsumerSecretSet: boolean;
  wcEnabled: boolean;
  aiConciergePrompt: string | null;
  aiConciergePromptIsDefault: boolean;
};

const AI_PROMPT_MAX_CHARS = 8000;

const DEFAULTS: AdminSettings = {
  menuImportEnabled: true,
  showOutOfStock: false,
  enabledProcessors: ["stripe"],
  checkoutConversionPreview: false,
  merchantImageEnabled: true,
  autoPrintOnPayment: false,
  receiptTemplateStyle: "standard",
  labelTemplateStyle: "standard",
  purgeMode: "delayed",
  purgeDelayHours: 72,
  keepAuditToken: true,
  keepFailedPaymentLogs: true,
  receiptLineNameMode: "lucifer_only",
  wcStoreUrl: "https://lucifercruz.com",
  wcConsumerKeySet: false,
  wcConsumerSecretSet: false,
  wcEnabled: true,
  aiConciergePrompt: null,
  aiConciergePromptIsDefault: true,
};

export default function AdminSettingsPage() {
  const { getToken } = useAuth();
  const [settings, setSettings] = useState<AdminSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // WooCommerce credential form state (separate from general settings)
  const [wcStoreUrl, setWcStoreUrl] = useState("https://lucifercruz.com");
  const [wcKey, setWcKey] = useState("");
  const [wcSecret, setWcSecret] = useState("");
  const [showWcSecret, setShowWcSecret] = useState(false);
  const [wcSaving, setWcSaving] = useState(false);
  const [wcSaved, setWcSaved] = useState(false);
  const [wcError, setWcError] = useState<string | null>(null);
  const [wcTesting, setWcTesting] = useState(false);
  const [wcTestResult, setWcTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const [genRes, wcRes] = await Promise.all([
          fetch("/api/admin/settings", { headers: { Authorization: `Bearer ${token}` } }),
          fetch("/api/admin/settings/woocommerce", { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        let merged: Partial<AdminSettings> = {};
        if (genRes.ok) merged = { ...merged, ...(await genRes.json()) };
        if (wcRes.ok) {
          const wc = await wcRes.json();
          merged = {
            ...merged,
            wcStoreUrl: wc.wcStoreUrl ?? wc.wc_store_url ?? "https://lucifercruz.com",
            wcConsumerKeySet: !!(wc.wcConsumerKeySet ?? wc.hasConsumerKey),
            wcConsumerSecretSet: !!(wc.wcConsumerSecretSet ?? wc.hasConsumerSecret),
            wcEnabled: wc.wcEnabled ?? wc.enabled ?? true,
          };
          setWcStoreUrl(merged.wcStoreUrl ?? "https://lucifercruz.com");
        }
        setSettings(s => ({ ...s, ...merged }));
      } catch { /* ignore fetch errors */ }
      setLoading(false);
    })();
  }, [getToken]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(settings),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error ?? "Save failed"); return; }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error)?.message ?? "Network error");
    } finally {
      setSaving(false);
    }
  }

  async function saveWooCredentials() {
    if (!wcKey || !wcSecret) {
      setWcError("Both Consumer Key and Consumer Secret are required.");
      return;
    }
    setWcSaving(true);
    setWcError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/settings/woocommerce", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ wcStoreUrl, wcConsumerKey: wcKey, wcConsumerSecret: wcSecret, enabled: settings.wcEnabled }),
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        setWcError(`Server returned an unexpected response (HTTP ${res.status}). Make sure the API server is running.`);
        return;
      }
      const data = await res.json();
      if (!res.ok) { setWcError(data.error ?? "Save failed"); return; }
      setSettings(s => ({ ...s, wcStoreUrl: data.wcStoreUrl, wcConsumerKeySet: data.wcConsumerKeySet, wcConsumerSecretSet: data.wcConsumerSecretSet, wcEnabled: data.wcEnabled ?? s.wcEnabled }));
      setWcKey("");
      setWcSecret("");
      setWcSaved(true);
      setTimeout(() => setWcSaved(false), 3000);
    } catch (e) {
      setWcError((e as Error)?.message ?? "Network error");
    } finally {
      setWcSaving(false);
    }
  }

  async function toggleWooEnabled(enabled: boolean) {
    setSettings(s => ({ ...s, wcEnabled: enabled }));
    try {
      const token = await getToken();
      await fetch("/api/admin/settings/woocommerce", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled }),
      });
    } catch { /* ignore */ }
  }

  async function testWooConnection() {
    setWcTesting(true);
    setWcTestResult(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/woocommerce/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setWcTestResult({ ok: true, message: `Connected${data.wcVersion ? ` — WooCommerce ${data.wcVersion}` : ""}` });
      } else {
        setWcTestResult({ ok: false, message: data.message ?? data.error ?? `HTTP ${res.status}` });
      }
    } catch (e) {
      setWcTestResult({ ok: false, message: (e as Error)?.message ?? "Network error" });
    } finally {
      setWcTesting(false);
    }
  }

  function set<K extends keyof AdminSettings>(key: K, value: AdminSettings[K]) {
    setSettings(s => ({ ...s, [key]: value }));
  }

  function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
    return (
      <div className="flex items-center justify-between py-4 border-b border-border/30 last:border-0">
        <div className="flex-1 pr-8">
          <div className="text-sm font-medium">{label}</div>
          {description && <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</div>}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    );
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">Loading settings...</div>
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Settings size={18} className="text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Admin Settings</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Configure ordering, printing, and data retention</p>
          </div>
        </div>
        <Button onClick={save} disabled={saving} className="gap-2 rounded-xl">
          {saving ? <RefreshCw size={14} className="animate-spin" /> : saved ? <CheckCircle2 size={14} /> : <Save size={14} />}
          {saved ? "Saved!" : saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      {error && (
        <div className="p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-sm">{error}</div>
      )}

      <Tabs defaultValue="products">
        <TabsList className="rounded-xl bg-muted/30 border border-border/40 mb-2">
          <TabsTrigger value="products" className="rounded-lg text-xs">Products</TabsTrigger>
          <TabsTrigger value="checkout" className="rounded-lg text-xs">Checkout</TabsTrigger>
          <TabsTrigger value="printing" className="rounded-lg text-xs">Printing</TabsTrigger>
          <TabsTrigger value="purge" className="rounded-lg text-xs">Purge</TabsTrigger>
          <TabsTrigger value="woocommerce" className="rounded-lg text-xs">WooCommerce</TabsTrigger>
          <TabsTrigger value="ai" className="rounded-lg text-xs">AI Concierge</TabsTrigger>
        </TabsList>

        {/* Products */}
        <TabsContent value="products">
          <div className="glass-card rounded-2xl p-5 border border-border/40">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">Product Settings</div>

            <SettingRow label="Enable Menu Import" description="Allow admins to import products via CSV upload.">
              <Switch checked={settings.menuImportEnabled} onCheckedChange={v => set("menuImportEnabled", v)} />
            </SettingRow>

            <SettingRow label="Show Out-of-Stock Items" description="Display products with alavont_in_stock = false in the customer catalog.">
              <Switch checked={settings.showOutOfStock} onCheckedChange={v => set("showOutOfStock", v)} />
            </SettingRow>
          </div>
        </TabsContent>

        {/* Checkout */}
        <TabsContent value="checkout">
          <div className="glass-card rounded-2xl p-5 border border-border/40 space-y-1">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">Checkout Settings</div>

            <SettingRow label="Checkout Conversion Preview" description="Show customers a brief summary before payment that the cart has been converted to merchant naming. Does not reveal internal mapping logic.">
              <Switch checked={settings.checkoutConversionPreview} onCheckedChange={v => set("checkoutConversionPreview", v)} />
            </SettingRow>

            <SettingRow label="Use Merchant Images" description="Send Lucifer Cruz image URLs to the payment processor instead of Alavont image URLs.">
              <Switch checked={settings.merchantImageEnabled} onCheckedChange={v => set("merchantImageEnabled", v)} />
            </SettingRow>

            <SettingRow label="Enabled Payment Processors" description="Active payment methods available at checkout.">
              <div className="flex flex-wrap gap-2">
                {["stripe", "paypal", "cashapp", "venmo"].map(p => {
                  const active = settings.enabledProcessors.includes(p);
                  return (
                    <button
                      key={p}
                      onClick={() => set("enabledProcessors", active
                        ? settings.enabledProcessors.filter(x => x !== p)
                        : [...settings.enabledProcessors, p]
                      )}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all capitalize ${active ? "bg-primary/15 border-primary/40 text-primary" : "bg-muted/20 border-border/40 text-muted-foreground hover:border-border"}`}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </SettingRow>
          </div>
        </TabsContent>

        {/* Printing */}
        <TabsContent value="printing">
          <div className="glass-card rounded-2xl p-5 border border-border/40">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">Printing Settings</div>

            <SettingRow label="Auto-Print on Payment Success" description="Automatically trigger receipt and label printing when a payment is confirmed.">
              <Switch checked={settings.autoPrintOnPayment} onCheckedChange={v => set("autoPrintOnPayment", v)} />
            </SettingRow>

            <SettingRow label="Receipt Template Style">
              <Select value={settings.receiptTemplateStyle} onValueChange={v => set("receiptTemplateStyle", v)}>
                <SelectTrigger className="w-36 h-8 text-xs rounded-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="compact">Compact</SelectItem>
                  <SelectItem value="detailed">Detailed</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow label="Label Template Style">
              <Select value={settings.labelTemplateStyle} onValueChange={v => set("labelTemplateStyle", v)}>
                <SelectTrigger className="w-36 h-8 text-xs rounded-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="minimal">Minimal</SelectItem>
                  <SelectItem value="full">Full Detail</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow label="Receipt Line Item Name Mode" description="Controls which product name appears on customer receipts. 'Both' prints Alavont name + LC secondary line.">
              <Select value={settings.receiptLineNameMode} onValueChange={v => set("receiptLineNameMode", v)}>
                <SelectTrigger className="w-40 h-8 text-xs rounded-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alavont_only">Alavont Only</SelectItem>
                  <SelectItem value="lucifer_only">Lucifer Cruz Only</SelectItem>
                  <SelectItem value="both">Both (Dual Line)</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
          </div>
        </TabsContent>

        {/* Purge */}
        <TabsContent value="purge">
          <div className="space-y-4">
            <div className="glass-card rounded-2xl p-5 border border-border/40">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">Data Purge Settings</div>

              <div className="text-xs text-muted-foreground bg-muted/20 rounded-xl p-3 mb-4 leading-relaxed border border-border/30">
                Note: Even when orders are deleted from this app, payment processors retain their own records independently. Purging here only affects this platform's database.
              </div>

              <SettingRow label="Purge Mode" description="How completed order data is removed after fulfillment.">
                <Select value={settings.purgeMode} onValueChange={v => set("purgeMode", v)}>
                  <SelectTrigger className="w-40 h-8 text-xs rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="immediate">Immediate Hard Delete</SelectItem>
                    <SelectItem value="delayed">Delayed Delete</SelectItem>
                    <SelectItem value="partial">Partial Purge (PII only)</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>

              {settings.purgeMode === "delayed" && (
                <SettingRow label="Purge Delay (hours)" description="How many hours after completion before the order is automatically purged.">
                  <Input
                    type="number"
                    min={1}
                    max={8760}
                    value={settings.purgeDelayHours}
                    onChange={e => set("purgeDelayHours", parseInt(e.target.value) || 72)}
                    className="w-24 h-8 text-xs rounded-lg"
                  />
                </SettingRow>
              )}

              <SettingRow label="Keep Audit Token" description="After purge, retain an anonymous reference token for compliance and payment reconciliation.">
                <Switch checked={settings.keepAuditToken} onCheckedChange={v => set("keepAuditToken", v)} />
              </SettingRow>

              <SettingRow label="Keep Failed Payment Logs" description="Retain records of failed or declined payment attempts even after the order is purged.">
                <Switch checked={settings.keepFailedPaymentLogs} onCheckedChange={v => set("keepFailedPaymentLogs", v)} />
              </SettingRow>
            </div>

            {/* Mode descriptions */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { mode: "immediate", title: "Immediate Hard Delete", desc: "Deletes order, items, customer details, queue details, and notes immediately on fulfillment." },
                { mode: "delayed", title: "Delayed Delete", desc: "Marks order complete, keeps encrypted for the configured delay period, then auto-deletes via background job." },
                { mode: "partial", title: "Partial Purge", desc: "Removes customer-identifying data and notes. Keeps minimal payment reference, timestamp, amount, and audit token." },
              ].map(({ mode, title, desc }) => (
                <div
                  key={mode}
                  className={`p-4 rounded-xl border text-xs leading-relaxed cursor-pointer transition-all ${settings.purgeMode === mode ? "border-primary/40 bg-primary/[0.06]" : "border-border/30 bg-muted/10"}`}
                  onClick={() => set("purgeMode", mode)}
                >
                  <div className={`font-semibold mb-1 ${settings.purgeMode === mode ? "text-primary" : ""}`}>{title}</div>
                  <div className="text-muted-foreground">{desc}</div>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        {/* WooCommerce */}
        <TabsContent value="woocommerce">
          <div className="space-y-4">
            {/* Current status */}
            <div className="glass-card rounded-2xl p-5 border border-border/40">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                  style={{ background: "linear-gradient(135deg, #DC143C, #8B0000)" }}>
                  <ShoppingBag size={14} className="text-white" />
                </div>
                <div>
                  <div className="text-sm font-semibold">WooCommerce Integration</div>
                  <div className="text-xs text-muted-foreground">Credentials are saved to the database and used automatically for all syncs</div>
                </div>
              </div>

              {/* Status badges */}
              <div className="flex flex-wrap gap-2 mb-5">
                <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${settings.wcConsumerKeySet ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-muted/30 text-muted-foreground border border-border/30"}`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${settings.wcConsumerKeySet ? "bg-green-400" : "bg-muted-foreground"}`} />
                  Consumer Key: {settings.wcConsumerKeySet ? "Saved" : "Not set"}
                </div>
                <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${settings.wcConsumerSecretSet ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-muted/30 text-muted-foreground border border-border/30"}`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${settings.wcConsumerSecretSet ? "bg-green-400" : "bg-muted-foreground"}`} />
                  Consumer Secret: {settings.wcConsumerSecretSet ? "Saved" : "Not set"}
                </div>
                {settings.wcConsumerKeySet && settings.wcConsumerSecretSet && (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    Store: {settings.wcStoreUrl}
                  </div>
                )}
              </div>

              {/* Credential form */}
              <div className="space-y-3">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                  {settings.wcConsumerKeySet && settings.wcConsumerSecretSet ? "Update Credentials" : "Set Credentials"}
                </div>

                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">Store URL</label>
                  <Input
                    value={wcStoreUrl}
                    onChange={e => setWcStoreUrl(e.target.value)}
                    placeholder="https://lucifercruz.com"
                    className="h-9 text-sm rounded-xl bg-background/50"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">
                    Consumer Key {settings.wcConsumerKeySet && <span className="text-green-400 normal-case font-normal">(currently saved — enter new key to replace)</span>}
                  </label>
                  <Input
                    value={wcKey}
                    onChange={e => setWcKey(e.target.value)}
                    placeholder="ck_xxxxxxxxxxxxxxxxxxxx"
                    className="h-9 text-sm rounded-xl bg-background/50 font-mono text-xs"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1 block">
                    Consumer Secret {settings.wcConsumerSecretSet && <span className="text-green-400 normal-case font-normal">(currently saved — enter new secret to replace)</span>}
                  </label>
                  <div className="relative">
                    <Input
                      type={showWcSecret ? "text" : "password"}
                      value={wcSecret}
                      onChange={e => setWcSecret(e.target.value)}
                      placeholder="cs_xxxxxxxxxxxxxxxxxxxx"
                      className="h-9 text-sm rounded-xl bg-background/50 font-mono text-xs pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowWcSecret(s => !s)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showWcSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </div>

                <div className="text-[11px] text-muted-foreground leading-relaxed bg-muted/20 rounded-xl p-3 border border-border/30">
                  <strong>How to get your keys:</strong> WooCommerce → Settings → Advanced → REST API → Add Key. Set Permissions to <strong>Read</strong>.{" "}
                  <a
                    href="https://lucifercruz.com/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-primary"
                  >
                    Open WooCommerce settings ↗
                  </a>
                </div>

                {wcError && (
                  <div className="p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-xs">{wcError}</div>
                )}

                {wcTestResult && (
                  <div className={`p-3 rounded-xl text-xs ${wcTestResult.ok ? "border border-green-500/30 bg-green-500/10 text-green-400" : "border border-red-500/30 bg-red-500/10 text-red-400"}`}>
                    {wcTestResult.ok ? "✓ " : "✗ "}{wcTestResult.message}
                  </div>
                )}

                <div className="flex flex-wrap gap-2 items-center">
                  <Button
                    onClick={saveWooCredentials}
                    disabled={wcSaving || !wcKey || !wcSecret}
                    className="gap-2 rounded-xl"
                  >
                    {wcSaving ? <RefreshCw size={14} className="animate-spin" /> : wcSaved ? <CheckCircle2 size={14} /> : <Save size={14} />}
                    {wcSaved ? "Credentials Saved!" : wcSaving ? "Saving..." : "Save WooCommerce Credentials"}
                  </Button>

                  <Button
                    onClick={testWooConnection}
                    disabled={wcTesting || (!settings.wcConsumerKeySet && !wcKey)}
                    variant="outline"
                    className="gap-2 rounded-xl"
                  >
                    {wcTesting ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                    {wcTesting ? "Testing..." : "Test Connection"}
                  </Button>

                  <div className="flex items-center gap-2 ml-auto">
                    <span className="text-xs text-muted-foreground">Enabled</span>
                    <Switch
                      checked={settings.wcEnabled}
                      onCheckedChange={v => void toggleWooEnabled(v)}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* AI Concierge */}
        <TabsContent value="ai">
          <div className="glass-card rounded-2xl p-5 border border-border/40 space-y-4">
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1">AI Concierge System Prompt</div>
              <div className="text-[11px] text-muted-foreground leading-relaxed">
                Controls how Zappy (the customer-facing AI order helper) introduces itself and what rules it follows. Leave blank to use the built-in default prompt.
              </div>
            </div>

            <div className="text-[11px] text-muted-foreground bg-muted/20 rounded-xl p-3 border border-border/30 leading-relaxed">
              <strong>Placeholders:</strong> <code className="px-1 py-0.5 rounded bg-background/50 font-mono">{"{{itemCount}}"}</code> — number of available items.{" "}
              <code className="px-1 py-0.5 rounded bg-background/50 font-mono">{"{{catalog}}"}</code> — bulleted catalog summary (name, category, price). Both are substituted server-side at request time.
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Prompt</label>
                <span className={`text-[10px] ${(settings.aiConciergePrompt?.length ?? 0) > AI_PROMPT_MAX_CHARS ? "text-red-400" : "text-muted-foreground"}`}>
                  {settings.aiConciergePrompt?.length ?? 0} / {AI_PROMPT_MAX_CHARS}
                </span>
              </div>
              <textarea
                value={settings.aiConciergePrompt ?? ""}
                onChange={e => set("aiConciergePrompt", e.target.value)}
                placeholder="Leave blank to use the built-in default prompt."
                rows={14}
                maxLength={AI_PROMPT_MAX_CHARS}
                className="w-full text-xs font-mono rounded-xl bg-background/50 border border-border/40 p-3 leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              {settings.aiConciergePromptIsDefault && (
                <div className="text-[10px] text-muted-foreground mt-1">
                  Currently using the built-in default prompt.
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => set("aiConciergePrompt", null)}
                disabled={settings.aiConciergePromptIsDefault && !settings.aiConciergePrompt}
                className="rounded-xl gap-2"
              >
                Reset to default
              </Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
