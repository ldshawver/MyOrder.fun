import { useState, useEffect } from "react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { useAuth } from "@clerk/react";
import { useToast } from "@/hooks/use-toast";
import { Bell, Mail, MessageSquare, Monitor, ShieldAlert, Package, Clock, Users, AlertTriangle } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

type NotifPrefs = {
  smsEnabled: boolean;
  emailEnabled: boolean;
  pushEnabled: boolean;
  newOrderAlerts: boolean;
  orderReadyAlerts: boolean;
  overdueOrderAlerts: boolean;
  shiftReminders: boolean;
  systemHealthAlerts: boolean;
};

const DEFAULTS: NotifPrefs = {
  smsEnabled: false,
  emailEnabled: true,
  pushEnabled: true,
  newOrderAlerts: true,
  orderReadyAlerts: true,
  overdueOrderAlerts: true,
  shiftReminders: true,
  systemHealthAlerts: false,
};

export default function NotificationSettings() {
  const { data: user, isLoading, refetch } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const { getToken } = useAuth();
  const { toast } = useToast();
  const [prefs, setPrefs] = useState<NotifPrefs>(DEFAULTS);
  const [saved, setSaved] = useState<NotifPrefs>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  const isAdmin = user?.role === "admin" || user?.role === "global_admin";
  const isCsrOrAbove = user?.role === "customer_service_rep" || isAdmin;

  useEffect(() => {
    if (user) {
      const stored = user.notificationPreferences as Partial<NotifPrefs> | undefined;
      const loaded: NotifPrefs = {
        smsEnabled: (user.smsOptIn as boolean | undefined) ?? stored?.smsEnabled ?? DEFAULTS.smsEnabled,
        emailEnabled: stored?.emailEnabled ?? DEFAULTS.emailEnabled,
        pushEnabled: stored?.pushEnabled ?? DEFAULTS.pushEnabled,
        newOrderAlerts: stored?.newOrderAlerts ?? DEFAULTS.newOrderAlerts,
        orderReadyAlerts: stored?.orderReadyAlerts ?? DEFAULTS.orderReadyAlerts,
        overdueOrderAlerts: stored?.overdueOrderAlerts ?? DEFAULTS.overdueOrderAlerts,
        shiftReminders: stored?.shiftReminders ?? DEFAULTS.shiftReminders,
        systemHealthAlerts: stored?.systemHealthAlerts ?? DEFAULTS.systemHealthAlerts,
      };
      setPrefs(loaded);
      setSaved(loaded);
    }
  }, [user]);

  const dirty = JSON.stringify(prefs) !== JSON.stringify(saved);

  function toggle(key: keyof NotifPrefs) {
    setPrefs((p) => ({ ...p, [key]: !p[key] }));
  }

  async function save() {
    setSaving(true);
    try {
      const token = await getToken();
      const res = await fetch(`${import.meta.env.BASE_URL}api/users/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          notificationPreferences: prefs,
          smsOptIn: prefs.smsEnabled,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to save settings");
      }
      await refetch();
      setSaved(prefs);
      toast({ title: "Settings saved", description: "Your notification preferences have been updated." });
    } catch (e) {
      toast({
        title: "Could not save",
        description: e instanceof Error ? e.message : "Failed to save notification settings",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-2xl mx-auto mt-8">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse bg-muted/20 rounded-2xl" />
        ))}
      </div>
    );
  }

  if (!user || fetchError) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center max-w-md mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-destructive/10 flex items-center justify-center mb-4">
          <AlertTriangle size={24} className="text-destructive" />
        </div>
        <h3 className="font-semibold text-sm mb-1">Could not load settings</h3>
        <p className="text-xs text-muted-foreground mb-4">
          There was a problem loading your notification preferences. Please refresh and try again.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="rounded-xl text-xs"
          onClick={() => { setFetchError(false); void refetch(); }}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-title">
          Notification Settings
        </h1>
        <p className="text-sm text-muted-foreground mt-1" data-testid="text-subtitle">
          Choose how and when you want to be notified.
        </p>
      </div>

      {/* Channels */}
      <Card className="glass-card rounded-2xl border-border/40">
        <CardHeader className="pb-2 border-b border-border/40">
          <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Monitor size={14} />
            Notification Channels
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-5 space-y-5">
          <SettingRow
            icon={<MessageSquare size={16} className="text-primary" />}
            label="SMS Notifications"
            description="Receive text messages for important updates. Requires a phone number on your account."
            checked={prefs.smsEnabled}
            onToggle={() => toggle("smsEnabled")}
            testId="switch-sms"
          />
          <SettingRow
            icon={<Mail size={16} className="text-primary" />}
            label="Email Notifications"
            description="Receive email updates for order confirmations and status changes."
            checked={prefs.emailEnabled}
            onToggle={() => toggle("emailEnabled")}
            testId="switch-email"
          />
          <SettingRow
            icon={<Bell size={16} className="text-primary" />}
            label="Push / Browser Notifications"
            description="Receive real-time browser notifications while you have the platform open."
            checked={prefs.pushEnabled}
            onToggle={() => toggle("pushEnabled")}
            testId="switch-push"
          />
        </CardContent>
      </Card>

      {/* Alert types */}
      <Card className="glass-card rounded-2xl border-border/40">
        <CardHeader className="pb-2 border-b border-border/40">
          <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Bell size={14} />
            Alert Types
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-5 space-y-5">
          <SettingRow
            icon={<Package size={16} className="text-primary" />}
            label="New Order Alerts"
            description="Get notified when a new order is placed."
            checked={prefs.newOrderAlerts}
            onToggle={() => toggle("newOrderAlerts")}
            testId="switch-new-orders"
          />
          <SettingRow
            icon={<Package size={16} className="text-green-500" />}
            label="Order Ready Alerts"
            description="Get notified when an order is marked ready for pickup or delivery."
            checked={prefs.orderReadyAlerts}
            onToggle={() => toggle("orderReadyAlerts")}
            testId="switch-order-ready"
          />
          <SettingRow
            icon={<Clock size={16} className="text-amber-500" />}
            label="Overdue Order Alerts"
            description="Get notified when an order has been waiting too long."
            checked={prefs.overdueOrderAlerts}
            onToggle={() => toggle("overdueOrderAlerts")}
            testId="switch-overdue"
          />

          {isCsrOrAbove && (
            <SettingRow
              icon={<Users size={16} className="text-blue-500" />}
              label="CSR Shift Reminders"
              description="Reminders when your shift is starting, ending, or if you have open items."
              checked={prefs.shiftReminders}
              onToggle={() => toggle("shiftReminders")}
              testId="switch-shift-reminders"
            />
          )}

          {isAdmin && (
            <SettingRow
              icon={<ShieldAlert size={16} className="text-destructive" />}
              label="System Health Alerts"
              description="Admin-only: alerts for platform errors, failed jobs, or critical system events."
              checked={prefs.systemHealthAlerts}
              onToggle={() => toggle("systemHealthAlerts")}
              testId="switch-system-health"
              adminOnly
            />
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3 pb-4">
        <Button
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-xl font-semibold text-sm h-10 px-6"
          data-testid="button-save-settings"
        >
          {saving ? "Saving…" : "Save Settings"}
        </Button>
        {dirty && !saving && (
          <span className="text-xs text-muted-foreground">You have unsaved changes.</span>
        )}
      </div>
    </div>
  );
}

type SettingRowProps = {
  icon: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  testId: string;
  adminOnly?: boolean;
};

function SettingRow({ icon, label, description, checked, onToggle, testId, adminOnly }: SettingRowProps) {
  return (
    <div className="flex items-start gap-4">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-muted/30 border border-border/40 mt-0.5">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <Label className="text-sm font-semibold leading-tight cursor-pointer" htmlFor={testId}>
            {label}
          </Label>
          {adminOnly && (
            <span className="text-[10px] uppercase tracking-wider font-mono text-destructive/70 bg-destructive/8 border border-destructive/20 px-1.5 py-0.5 rounded">
              Admin
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      </div>
      <Switch
        id={testId}
        checked={checked}
        onCheckedChange={onToggle}
        data-testid={testId}
        className="mt-1 shrink-0"
      />
    </div>
  );
}
