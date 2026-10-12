import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";

type Settings = {
  lightEnabled: boolean; smsEnabled: boolean; alertDurationSeconds: number;
  generalAssigneeUserId: number | null; generalFallbackUserId: number | null;
};
type Recipient = { id: number; label: string; role: string };
const defaults: Settings = { lightEnabled: false, smsEnabled: false, alertDurationSeconds: 60,
  generalAssigneeUserId: null, generalFallbackUserId: null };

export default function OrderNotifications() {
  const { getToken } = useAuth();
  const [settings, setSettings] = useState<Settings>(defaults);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [ready, setReady] = useState({ light: false, sms: false });
  const [message, setMessage] = useState("");
  useEffect(() => {
    let alive = true;
    getToken().then(token => fetch("/api/admin/order-notifications", { headers: { Authorization: `Bearer ${token}` } }))
      .then(async response => { if (!response.ok) throw new Error("Could not load order alert settings"); return response.json(); })
      .then(data => { if (alive) { setSettings(data.settings); setRecipients(data.recipients); setReady({ light: data.lightConfigured, sms: data.smsConfigured }); } })
      .catch(error => { if (alive) setMessage(String(error.message)); });
    return () => { alive = false; };
  }, [getToken]);
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
  const update = (patch: Partial<Settings>) => setSettings(current => ({ ...current, ...patch }));
  return <main className="mx-auto max-w-2xl space-y-5 p-6">
    <h1 className="text-2xl font-semibold">New order alerts</h1>
    <p className="text-sm text-muted-foreground">Alerts are sent after an order is saved. Delivery problems never change the order.</p>
    <section className="rounded-lg border p-4 space-y-3">
      <h2 className="font-medium">MyOrder.fun light</h2>
      <p className="text-sm">Server device configuration: {ready.light ? "Ready" : "Not configured"}</p>
      <label className="flex gap-2"><input type="checkbox" checked={settings.lightEnabled} disabled={!ready.light}
        onChange={event => update({ lightEnabled: event.target.checked })} /> Enable order light alerts</label>
      <label className="block">Alert duration (seconds)
        <input className="ml-2 w-24 rounded border p-1" type="number" min={10} max={600} value={settings.alertDurationSeconds}
          onChange={event => update({ alertDurationSeconds: Number(event.target.value) })} /></label>
    </section>
    <section className="rounded-lg border p-4 space-y-3">
      <h2 className="font-medium">Staff SMS</h2>
      <p className="text-sm">Provider configuration: {ready.sms ? "Ready" : "Not configured"}</p>
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
    </section>
    <button className="rounded bg-primary px-4 py-2 text-primary-foreground" onClick={save}>Save settings</button>
    {message && <p role="status">{message}</p>}
  </main>;
}
