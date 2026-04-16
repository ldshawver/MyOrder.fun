import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { Settings, Save, RefreshCw, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
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
};

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
};

export default function AdminSettingsPage() {
  const { getToken } = useAuth();
  const [settings, setSettings] = useState<AdminSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch("/api/admin/settings", { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const data = await res.json();
          setSettings({ ...DEFAULTS, ...data });
        }
      } catch {}
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
    } catch (e: any) {
      setError(e?.message ?? "Network error");
    } finally {
      setSaving(false);
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
      </Tabs>
    </div>
  );
}
