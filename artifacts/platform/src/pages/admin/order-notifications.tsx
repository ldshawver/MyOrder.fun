import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { repairPushNotifications } from "@/lib/pwaPushRepair";

type Settings = {
  lightEnabled: boolean; smsEnabled: boolean; alertDurationSeconds: number;
  generalAssigneeUserId: number | null; generalFallbackUserId: number | null;
};
type Recipient = { id: number; label: string; role: string };
type ProviderStatus = { configured: boolean; connection: string; accountSidMasked?: string | null; sender?: string | null; clientIdMasked?: string | null; region?: string | null; deviceId?: string | null; switchCode?: string };
type DeliveryStatus = { notificationType: string; state: string; failureClass: string | null; maskedDestination: string | null; updatedAt: string };
const defaults: Settings = { lightEnabled: false, smsEnabled: false, alertDurationSeconds: 60,
  generalAssigneeUserId: null, generalFallbackUserId: null };

export default function OrderNotifications() {
  const { getToken } = useAuth();
  const [settings, setSettings] = useState<Settings>(defaults);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [ready, setReady] = useState({ light: false, sms: false });
  const [message, setMessage] = useState("");
  const [push, setPush] = useState({ enabled: false, activeSubscriptionCount: 0, deliveryConfigured: false });
  const [pushBusy, setPushBusy] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [smsProvider, setSmsProvider] = useState<ProviderStatus>({ configured: false, connection: "not_configured" });
  const [tuyaProvider, setTuyaProvider] = useState<ProviderStatus>({ configured: false, connection: "not_configured" });
  const [smsForm, setSmsForm] = useState({ accountSid: "", authToken: "", sender: "", testTo: "" });
  const [tuyaForm, setTuyaForm] = useState({ clientId: "", clientSecret: "", region: "us", deviceId: "", switchCode: "switch_1" });
  const [tuyaDevices, setTuyaDevices] = useState<Array<{ id: string; name: string; online: boolean }>>([]);
  const [deliveries, setDeliveries] = useState<DeliveryStatus[]>([]);
  const [providerBusy, setProviderBusy] = useState(false);
  const [configureSms, setConfigureSms] = useState(false);
  const [configureTuya, setConfigureTuya] = useState(false);
  useEffect(() => {
    let alive = true;
    getToken().then(token => fetch("/api/admin/order-notifications", { headers: { Authorization: `Bearer ${token}` } }))
      .then(async response => { if (!response.ok) throw new Error("Could not load order alert settings"); return response.json(); })
      .then(data => { if (alive) { setSettings(data.settings); setRecipients(data.recipients); setReady({ light: data.lightConfigured, sms: data.smsConfigured }); setSmsProvider(data.smsProvider); setTuyaProvider(data.tuyaProvider); setDeliveries(data.deliveries ?? []); setSmsForm(current => ({ ...current, sender: data.smsProvider?.sender ?? "" })); setTuyaForm(current => ({ ...current, region: data.tuyaProvider?.region ?? "us", deviceId: data.tuyaProvider?.deviceId ?? "", switchCode: data.tuyaProvider?.switchCode ?? "switch_1" })); } })
      .catch(error => { if (alive) setMessage(String(error.message)); });
    return () => { alive = false; };
  }, [getToken]);
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) { setPermission("unsupported"); return; }
    setPermission(Notification.permission);
    let alive = true;
    getToken().then(token => fetch("/api/pwa/push/order-alerts", { headers: { Authorization: `Bearer ${token}` } }))
      .then(async response => { if (!response.ok) throw new Error("Could not load browser alert status"); return response.json(); })
      .then(data => { if (alive) setPush({ enabled: data.enabled, activeSubscriptionCount: data.activeSubscriptionCount, deliveryConfigured: data.deliveryConfigured }); })
      .catch(error => { if (alive) setMessage(String(error.message)); });
    return () => { alive = false; };
  }, [getToken]);
  async function setBrowserAlerts(enabled: boolean) {
    setPushBusy(true); setMessage("");
    try {
      if (enabled) {
        const repair = await repairPushNotifications(getToken);
        if (!repair.ok) throw new Error(repair.message);
        setPermission("granted");
      }
      const token = await getToken();
      const response = await fetch("/api/pwa/push/order-alerts", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ enabled }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not update browser alerts");
      setPush(current => ({ ...current, enabled, activeSubscriptionCount: data.activeSubscriptionCount }));
      setMessage(enabled ? "Browser order alerts are enabled on this device." : "Browser order alerts are disabled.");
      if (!enabled && "serviceWorker" in navigator) {
        try {
          const registration = await navigator.serviceWorker.getRegistration();
          const subscription = await registration?.pushManager.getSubscription();
          if (subscription) await subscription.unsubscribe();
        } catch { /* Server preference is already disabled and prevents delivery. */ }
      }
    } catch (error) {
      if (typeof window !== "undefined" && "Notification" in window) setPermission(Notification.permission);
      setMessage(error instanceof Error ? error.message : "Could not update browser alerts");
    }
    finally { setPushBusy(false); }
  }
  async function sendTestPush() {
    setPushBusy(true); setMessage("");
    try {
      const token = await getToken();
      const response = await fetch("/api/pwa/push/order-alerts/test", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Test notification failed");
      setMessage("Test notification sent through the push service.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Test notification failed"); }
    finally { setPushBusy(false); }
  }
  async function save() {
    setMessage("");
    try {
      const token = await getToken();
      const response = await fetch("/api/admin/order-notifications", {
        method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(settings),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save order alert settings");
      setSettings(data.settings); setMessage("Order alert settings saved.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save order alert settings"); }
  }
  async function providerRequest(path: string, method: "POST" | "PUT", body?: unknown) {
    const token = await getToken();
    const response = await fetch(path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Provider request failed");
    return data;
  }
  async function providerAction(action: () => Promise<void>) {
    setProviderBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : "Provider request failed"); }
    finally { setProviderBusy(false); }
  }
  async function saveSms() {
    await providerRequest("/api/admin/order-notifications/providers/sms", "PUT", { ...(smsForm.accountSid ? { accountSid: smsForm.accountSid } : {}), ...(smsForm.authToken ? { authToken: smsForm.authToken } : {}), sender: smsForm.sender });
    setSmsProvider(value => ({ ...value, configured: true, connection: "not_configured" })); setReady(value => ({ ...value, sms: false }));
    setSmsForm(value => ({ ...value, accountSid: "", authToken: "" })); setMessage("SMS credentials saved. Test the connection to enable SMS alerts.");
  }
  async function testSmsConnection() { const data = await providerRequest("/api/admin/order-notifications/providers/sms/test-connection", "POST"); setSmsProvider(value => ({ ...value, configured: true, connection: data.connection })); setReady(value => ({ ...value, sms: data.connection === "connected" })); setMessage("SMS provider connection verified."); }
  async function sendTestSms() { await providerRequest("/api/admin/order-notifications/providers/sms/test-message", "POST", { to: smsForm.testTo }); setMessage("Test SMS sent through the configured provider."); }
  async function saveTuya() {
    await providerRequest("/api/admin/order-notifications/providers/tuya", "PUT", { ...(tuyaForm.clientId ? { clientId: tuyaForm.clientId } : {}), ...(tuyaForm.clientSecret ? { clientSecret: tuyaForm.clientSecret } : {}), region: tuyaForm.region, deviceId: tuyaForm.deviceId || null, switchCode: tuyaForm.switchCode });
    setTuyaProvider(value => ({ ...value, configured: true, connection: "not_configured", deviceId: tuyaForm.deviceId || null })); setReady(value => ({ ...value, light: false }));
    setTuyaForm(value => ({ ...value, clientId: "", clientSecret: "" })); setMessage("Tuya credentials saved. Test the connection and select a device.");
  }
  async function testTuyaConnection() { const data = await providerRequest("/api/admin/order-notifications/providers/tuya/test-connection", "POST"); setTuyaProvider(value => ({ ...value, configured: true, connection: data.connection })); setReady(value => ({ ...value, light: data.connection === "connected" && Boolean(tuyaForm.deviceId) })); setMessage(`Tuya connection verified. ${data.deviceCount} device(s) discovered.`); }
  async function discoverTuyaDevices() { const token = await getToken(); const response = await fetch("/api/admin/order-notifications/providers/tuya/devices", { headers: { Authorization: `Bearer ${token}` } }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Device discovery failed"); setTuyaDevices(data.devices); setMessage(`${data.devices.length} Tuya device(s) found.`); }
  async function testTuyaLight() { await providerRequest("/api/admin/order-notifications/providers/tuya/test-light", "POST"); setTuyaProvider(value => ({ ...value, connection: "connected", configured: true })); setReady(value => ({ ...value, light: true })); setMessage("Test light command completed."); }
  const update = (patch: Partial<Settings>) => setSettings(current => ({ ...current, ...patch }));
  return <main className="mx-auto max-w-2xl space-y-5 p-6">
    <h1 className="text-2xl font-semibold">New order alerts</h1>
    <p className="text-sm text-muted-foreground">Alerts are sent after an order is saved. Delivery problems never change the order.</p>
    <section className="rounded-lg border p-4 space-y-3">
      <h2 className="font-medium">Browser order alerts</h2>
      <p className="text-sm">Status: <strong>{push.enabled ? "Enabled" : "Disabled"}</strong> · Browser permission: <strong>{permission}</strong></p>
      {!push.deliveryConfigured && <p role="note" className="text-sm text-amber-700">Browser push delivery is not configured on this server. Ask an administrator to configure Web Push before enabling alerts.</p>}
      {permission === "denied" && <p role="note" className="text-sm">Notifications are blocked in browser settings. Allow notifications for this site, then enable alerts again.</p>}
      {permission === "unsupported" && <p role="note" className="text-sm">This browser does not support notifications. Use a supported browser; on iPhone or iPad, install MyOrder.fun to the Home Screen and open it there.</p>}
      <div className="flex flex-wrap gap-2">
        <button className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={pushBusy} onClick={() => void setBrowserAlerts(!push.enabled)}>
          {pushBusy ? "Working…" : push.enabled ? "Disable" : "Enable"}
        </button>
        <button className="rounded border px-4 py-2 disabled:opacity-50" disabled={pushBusy || !push.enabled || permission !== "granted"} onClick={() => void sendTestPush()}>Send Test Notification</button>
      </div>
      <p className="text-xs text-muted-foreground">This setting is saved to your account and applies only to your active devices in this tenant. Current active devices: {push.activeSubscriptionCount}.</p>
    </section>
    <section className="rounded-lg border p-4 space-y-3">
      <h2 className="font-medium">MyOrder.fun light</h2>
      <div className="flex flex-wrap items-center gap-2"><p className="text-sm">Provider configuration: <strong>{tuyaProvider.connection === "connected" ? "Connected" : "Not configured"}</strong></p><button className="rounded border px-3 py-1" onClick={() => setConfigureTuya(value => !value)}>Configure Tuya</button></div>
      {configureTuya && <div className="space-y-2 rounded border p-3">
        <p className="text-xs text-muted-foreground">{tuyaProvider.clientIdMasked ? `Saved client ID: ${tuyaProvider.clientIdMasked}. Leave credential fields empty to keep saved values.` : "Enter the Tuya cloud project credentials."}</p>
        <input className="w-full rounded border p-2" aria-label="Tuya Access ID / Client ID" autoComplete="off" placeholder="Access ID / Client ID" value={tuyaForm.clientId} onChange={e => setTuyaForm(v => ({ ...v, clientId: e.target.value }))} />
        <input className="w-full rounded border p-2" aria-label="Tuya Access Secret / Client Secret" type="password" autoComplete="new-password" placeholder="Access Secret / Client Secret" value={tuyaForm.clientSecret} onChange={e => setTuyaForm(v => ({ ...v, clientSecret: e.target.value }))} />
        <label className="block">Cloud region <select className="ml-2 rounded border p-2" value={tuyaForm.region} onChange={e => setTuyaForm(v => ({ ...v, region: e.target.value }))}>{[["us","Americas"],["eu","Europe"],["in","India"],["cn","China"],["ueaz","Eastern US"],["weaz","Western Europe"]].map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <div className="flex flex-wrap gap-2"><button className="rounded border px-3 py-2 disabled:opacity-50" disabled={providerBusy} onClick={() => void providerAction(saveTuya)}>Save Credentials</button><button className="rounded border px-3 py-2 disabled:opacity-50" disabled={providerBusy} onClick={() => void providerAction(testTuyaConnection)}>Test Connection</button><button className="rounded border px-3 py-2 disabled:opacity-50" disabled={providerBusy} onClick={() => void providerAction(discoverTuyaDevices)}>Discover Devices</button></div>
        <label className="block">Device <select className="ml-2 max-w-full rounded border p-2" value={tuyaForm.deviceId} onChange={e => setTuyaForm(v => ({ ...v, deviceId: e.target.value }))}><option value="">Select a device</option>{tuyaDevices.map(device => <option key={device.id} value={device.id}>{device.name}{device.online ? " · online" : " · offline"}</option>)}</select></label>
        {tuyaDevices.filter(device => device.id === tuyaForm.deviceId).map(device => <p key={device.id} className="text-xs">Selected device status: {device.online ? "Online" : "Offline"}</p>)}
        <label className="block">Switch code <input className="ml-2 rounded border p-2" value={tuyaForm.switchCode} onChange={e => setTuyaForm(v => ({ ...v, switchCode: e.target.value }))} /></label>
        <button className="rounded border px-3 py-2 disabled:opacity-50" disabled={providerBusy || !tuyaProvider.configured || !tuyaForm.deviceId} onClick={() => void providerAction(testTuyaLight)}>Test Light</button>
      </div>}
      <label className="flex gap-2"><input type="checkbox" checked={settings.lightEnabled} disabled={!ready.light}
        onChange={event => update({ lightEnabled: event.target.checked })} /> Enable order light alerts</label>
      <label className="block">Alert duration (seconds)
        <input className="ml-2 w-24 rounded border p-1" type="number" min={10} max={600} value={settings.alertDurationSeconds}
          onChange={event => update({ alertDurationSeconds: Number(event.target.value) })} /></label>
    </section>
    <section className="rounded-lg border p-4 space-y-3">
      <h2 className="font-medium">Staff SMS</h2>
      <div className="flex flex-wrap items-center gap-2"><p className="text-sm">Provider configuration: <strong>{smsProvider.connection === "connected" ? "Connected" : "Not configured"}</strong></p><button className="rounded border px-3 py-1" onClick={() => setConfigureSms(value => !value)}>Configure SMS</button></div>
      {configureSms && <div className="space-y-2 rounded border p-3">
        <p className="text-sm">Provider: Twilio · Sender: {smsProvider.sender || "Not configured"}</p><p className="text-xs text-muted-foreground">{smsProvider.accountSidMasked ? `Saved account: ${smsProvider.accountSidMasked}. Leave credential fields empty to keep saved values.` : "Enter Twilio account credentials."}</p>
        <input className="w-full rounded border p-2" aria-label="Twilio Account SID" autoComplete="off" placeholder="Account SID" value={smsForm.accountSid} onChange={e => setSmsForm(v => ({ ...v, accountSid: e.target.value }))} />
        <input className="w-full rounded border p-2" aria-label="Twilio Auth Token" type="password" autoComplete="new-password" placeholder="Auth Token" value={smsForm.authToken} onChange={e => setSmsForm(v => ({ ...v, authToken: e.target.value }))} />
        <input className="w-full rounded border p-2" aria-label="Sender phone number or messaging service ID" placeholder="Sender phone number (+...) or Messaging Service ID (MG...)" value={smsForm.sender} onChange={e => setSmsForm(v => ({ ...v, sender: e.target.value }))} />
        <div className="flex flex-wrap gap-2"><button className="rounded border px-3 py-2 disabled:opacity-50" disabled={providerBusy} onClick={() => void providerAction(saveSms)}>Save Credentials</button><button className="rounded border px-3 py-2 disabled:opacity-50" disabled={providerBusy} onClick={() => void providerAction(testSmsConnection)}>Test Connection</button></div>
        <div className="flex flex-wrap gap-2"><input className="min-w-0 flex-1 rounded border p-2" aria-label="Test SMS recipient" placeholder="Test recipient (+15551234567)" value={smsForm.testTo} onChange={e => setSmsForm(v => ({ ...v, testTo: e.target.value }))} /><button className="rounded border px-3 py-2 disabled:opacity-50" disabled={providerBusy || !ready.sms || !smsForm.testTo} onClick={() => void providerAction(sendTestSms)}>Send Test SMS</button></div>
      </div>}
      <label className="flex gap-2"><input type="checkbox" checked={settings.smsEnabled} disabled={!ready.sms}
        onChange={event => update({ smsEnabled: event.target.checked })} /> Enable staff SMS for new orders</label>
      {([['generalAssigneeUserId', 'General Queue assigned Admin/Supervisor'],
        ['generalFallbackUserId', 'General Queue fallback']] as const).map(([key, label]) =>
        <label key={key} className="block">{label}
          <select className="ml-2 rounded border p-1" value={settings[key] ?? ""}
            onChange={event => update({ [key]: event.target.value ? Number(event.target.value) : null })}>
            <option value="">None</option>
            {recipients.map(user => <option key={user.id} value={user.id}>{user.label || `User ${user.id}`} ({user.role})</option>)}
          </select>
        </label>)}
      <p className="text-sm text-muted-foreground">Assigned, on-shift CSR orders notify that CSR. General Queue uses the explicit assignee, then the fallback.</p>
      {deliveries.length > 0 && <div className="space-y-1 border-t pt-2"><p className="text-sm font-medium">Recent delivery status</p>{deliveries.map((delivery, index) => <p className="text-xs" key={`${delivery.notificationType}-${delivery.updatedAt}-${index}`}>{delivery.notificationType === "staff_sms" ? "SMS" : "Light"}: {delivery.state}{delivery.failureClass ? ` (${delivery.failureClass})` : ""}{delivery.maskedDestination ? ` · ${delivery.maskedDestination}` : ""}</p>)}</div>}
    </section>
    <button className="rounded bg-primary px-4 py-2 text-primary-foreground" onClick={save}>Save settings</button>
    {message && <p role="status">{message}</p>}
  </main>;
}
