import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { AlertTriangle, Building2, CreditCard, Github, KeyRound, PlugZap, RefreshCw, Save, Settings, ShieldOff, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type Health = Record<string, "connected" | "missing_config" | "error">;

const integrations = [
  { key: "revenuecat", name: "RevenueCat", description: "Licenses, entitlements, subscription status, and tenant feature gates.", fields: ["API key", "Webhook secret", "Project ID"] },
  { key: "airtable", name: "Airtable", description: "Ops tables, intake forms, CRM sync, and back-office reporting.", fields: ["API key", "Base ID", "Default table"] },
  { key: "github", name: "GitHub", description: "Issue creation, release tracking, deployment metadata, and support handoffs.", fields: ["Token", "Repository", "Default labels"] },
  { key: "outlook", name: "Outlook / Microsoft 365", description: "Mailbox, calendar, OAuth redirect, and tenant admin notifications.", fields: ["Client ID", "Tenant ID", "Client secret", "Redirect URI"] },
  { key: "openai", name: "OpenAI", description: "AI concierge, support summaries, and internal drafting tools.", fields: ["API key", "Default model"] },
];

const tenants = [
  { name: "Lucifer Cruz", plan: "Enterprise", licenses: 18, billing: "Current", status: "active" },
  { name: "Alavont", plan: "Growth", licenses: 8, billing: "Trial", status: "active" },
  { name: "Demo Tenant", plan: "Starter", licenses: 3, billing: "Past due", status: "suspended" },
];

export default function GlobalAdminIntegrations() {
  const { getToken } = useAuth();
  const [health, setHealth] = useState<Health>({});
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  const refreshHealth = useCallback(async () => {
    setLoading(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/integrations/health", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setHealth(await res.json());
    } catch {
      setHealth({});
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  function saveDraft() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  }

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <PlugZap size={21} className="text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Platform Integrations</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Global-admin-only controls for integrations, OAuth apps, licenses, tenants, billing, and account suspension.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="rounded-xl gap-2" onClick={refreshHealth} disabled={loading}>{loading ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh health</Button>
          <Badge variant="secondary">Staging beta · settings forms UI-only until persistence APIs are connected</Badge>
          <Button className="rounded-xl gap-2" onClick={saveDraft}>{saved ? <Save size={14} /> : <KeyRound size={14} />}{saved ? "Saved draft" : "Save encrypted settings"}</Button>
        </div>
      </div>

      <Tabs defaultValue="integrations" className="space-y-4">
        <TabsList className="rounded-xl bg-muted/30 border border-border/40 flex flex-wrap h-auto justify-start">
          <TabsTrigger value="integrations" className="rounded-lg text-xs">External Integrations</TabsTrigger>
          <TabsTrigger value="oauth" className="rounded-lg text-xs">OAuth Apps</TabsTrigger>
          <TabsTrigger value="licenses" className="rounded-lg text-xs">Licenses & Billing</TabsTrigger>
          <TabsTrigger value="tenants" className="rounded-lg text-xs">Tenant Admin</TabsTrigger>
          <TabsTrigger value="settings" className="rounded-lg text-xs">Platform Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="integrations">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {integrations.map(integration => (
              <section key={integration.key} className="glass-card rounded-2xl p-5 border border-border/40 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl bg-muted/30 flex items-center justify-center">{integration.key === "github" ? <Github size={17} /> : <Settings size={17} />}</div>
                  <div className="flex-1"><div className="flex items-center gap-2"><h2 className="text-sm font-semibold uppercase tracking-widest">{integration.name}</h2><StatusBadge status={health[integration.key]} /></div><p className="text-xs text-muted-foreground mt-1 leading-relaxed">{integration.description}</p></div>
                  <Switch defaultChecked={health[integration.key] === "connected"} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {integration.fields.map(field => <Field key={field} label={field} placeholder={field.toLowerCase().includes("secret") || field.toLowerCase().includes("token") || field.toLowerCase().includes("key") ? "••••••••••••" : field} />)}
                </div>
              </section>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="oauth">
          <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4">
            <div><h2 className="text-sm font-semibold uppercase tracking-widest">OAuth & External Integration Settings</h2><p className="text-xs text-muted-foreground mt-1">Editable OAuth app registration settings for Microsoft Outlook, GitHub, Airtable extensions, RevenueCat webhooks.</p></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3"><Field label="OAuth redirect base URL" placeholder="https://app.myorder.fun/oauth/callback" /><Field label="Allowed callback domains" placeholder="app.myorder.fun, lucifercruz.com" /><Field label="Microsoft scopes" placeholder="offline_access User.Read Mail.Send Calendars.ReadWrite" /><Field label="GitHub scopes" placeholder="repo, workflow, read:org" /></div>
            <Textarea className="rounded-xl min-h-28" placeholder="Paste JSON metadata, webhook signing keys, or integration notes for global admins." />
          </section>
        </TabsContent>

        <TabsContent value="licenses">
          <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4">
            <div className="flex items-center gap-2"><CreditCard size={17} className="text-primary" /><h2 className="text-sm font-semibold uppercase tracking-widest">Licenses & Billing</h2></div>
            <div className="overflow-x-auto rounded-xl border border-border/40"><table className="w-full text-sm"><thead className="bg-muted/20 text-xs uppercase tracking-widest text-muted-foreground"><tr><th className="text-left p-3">Tenant</th><th className="text-left p-3">Plan</th><th className="text-left p-3">Licenses</th><th className="text-left p-3">Billing</th><th className="text-left p-3">Actions</th></tr></thead><tbody>{tenants.map(tenant => <tr key={tenant.name} className="border-t border-border/30"><td className="p-3 font-medium">{tenant.name}</td><td className="p-3">{tenant.plan}</td><td className="p-3 font-mono">{tenant.licenses}</td><td className="p-3"><Badge variant={tenant.billing === "Past due" ? "destructive" : "secondary"}>{tenant.billing}</Badge></td><td className="p-3"><div className="flex gap-2"><Button size="sm" variant="outline" className="rounded-xl">Edit</Button><Button size="sm" variant="outline" className="rounded-xl">Invoice</Button></div></td></tr>)}</tbody></table></div>
          </section>
        </TabsContent>

        <TabsContent value="tenants">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4"><div className="flex items-center gap-2"><Building2 size={17} className="text-primary" /><h2 className="text-sm font-semibold uppercase tracking-widest">Create Tenant</h2></div><div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><Field label="Company name" placeholder="New company" /><Field label="Slug" placeholder="new-company" /><Field label="Plan" placeholder="Growth" /><Field label="Admin email" placeholder="owner@example.com" /></div><Button className="rounded-xl gap-2"><Users size={14} /> Create tenant</Button></section>
            <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4"><div className="flex items-center gap-2"><ShieldOff size={17} className="text-destructive" /><h2 className="text-sm font-semibold uppercase tracking-widest">Suspend Account</h2></div><Select defaultValue="Demo Tenant"><SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger><SelectContent>{tenants.map(t => <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>)}</SelectContent></Select><Textarea className="rounded-xl min-h-24" placeholder="Suspension reason and internal notes" /><Button variant="destructive" className="rounded-xl gap-2"><AlertTriangle size={14} /> Suspend selected tenant</Button></section>
          </div>
        </TabsContent>

        <TabsContent value="settings">
          <section className="glass-card rounded-2xl p-5 border border-border/40 space-y-4"><h2 className="text-sm font-semibold uppercase tracking-widest">Global Platform Settings</h2><div className="grid grid-cols-1 md:grid-cols-3 gap-3"><Field label="Default license limit" placeholder="10" /><Field label="Trial length" placeholder="14 days" /><Field label="Billing grace period" placeholder="7 days" /></div>{["Require license before production access", "Auto-suspend past-due tenants", "Notify global admins on failed webhooks", "Require OAuth app review before activation"].map(item => <div key={item} className="rounded-xl border border-border/40 bg-muted/10 p-3 flex items-center justify-between"><span className="text-sm">{item}</span><Switch defaultChecked /></div>)}</section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatusBadge({ status }: { status?: "connected" | "missing_config" | "error" }) {
  if (!status) return <Badge variant="secondary">unknown</Badge>;
  if (status === "connected") return <Badge className="bg-green-500/15 text-green-400 border border-green-500/20">connected</Badge>;
  if (status === "error") return <Badge variant="destructive">error</Badge>;
  return <Badge variant="secondary">missing config</Badge>;
}

function Field({ label, placeholder }: { label: string; placeholder: string }) {
  return <div className="space-y-1"><Label className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</Label><Input className="rounded-xl" placeholder={placeholder} /></div>;
}
