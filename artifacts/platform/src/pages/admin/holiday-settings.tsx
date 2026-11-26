import { useState, type FormEvent } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { HolidayDecorationLayer, holidayDisplayKey, type HolidayTheme } from "@/components/HolidayDecorations";

type Preferences = {
  automatic: boolean;
  animated: boolean;
  disabled: HolidayTheme[];
  manual: HolidayTheme | null;
};
type Schedule = {
  settings: Preferences;
  version: number;
  timezone: string;
  themes: { id: HolidayTheme; name: string }[];
};
const endpoint = "/api/admin/settings/holiday-decorations";

export default function HolidaySettings() {
  const { getToken, userId, orgId } = useAuth();
  const queryClient = useQueryClient();
  const key = ["holiday-decoration-settings", userId, orgId];
  const schedule = useQuery({
    queryKey: key,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }): Promise<Schedule> => {
      const token = await getToken();
      if (!token) throw new Error("Sign in to manage decorations.");
      const response = await fetch(endpoint, { signal, headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("Could not load holiday decorations.");
      return response.json();
    },
  });
  const [edited, setEdited] = useState<{ settings: Preferences; version: number } | null>(null);
  const [preview, setPreview] = useState<HolidayTheme | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  if (schedule.isPending) return <p>Loading holiday decorations…</p>;
  if (!schedule.data) return <p role="alert">{schedule.error?.message}</p>;

  const current = schedule.data;
  const settings = edited?.settings ?? current.settings;
  function edit(changes: Partial<Preferences>) {
    setEdited({ settings: { ...settings, ...changes }, version: edited?.version ?? current.version });
    setMessage("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const token = await getToken();
      if (!token) throw new Error("Sign in again to save decorations.");
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, version: edited?.version ?? current.version }),
      });
      if (response.status === 409) throw new Error("Settings changed in another session. Reopen this page before saving.");
      if (!response.ok) throw new Error("Could not save holiday decorations.");
      const saved: Pick<Schedule, "settings" | "version"> = await response.json();
      queryClient.setQueryData(key, { ...current, ...saved });
      void queryClient.invalidateQueries({ queryKey: holidayDisplayKey });
      setEdited(null);
      setError(false);
      setMessage("Holiday decorations saved.");
    } catch (cause) {
      setError(true);
      setMessage(cause instanceof Error ? cause.message : "Could not save holiday decorations.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto max-w-2xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">Holiday Decorations</h1>
      <p className="text-sm text-muted-foreground">Themes start one calendar month before the holiday and run through the holiday in {current.timezone}. When dates overlap, the nearest holiday takes priority.</p>
      <form onSubmit={save}>
        <fieldset disabled={saving} className="space-y-5">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.automatic} onChange={event => edit({ automatic: event.target.checked })} />
            Enable automatic holiday decorations
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.animated} onChange={event => edit({ animated: event.target.checked })} />
            Enable animated effects
          </label>
          <label className="block">
            <span className="block text-sm font-medium">Manual theme</span>
            <select className="mt-1 max-w-full rounded-md border bg-background p-2" value={settings.manual ?? ""} onChange={event => edit({ manual: event.target.value as HolidayTheme || null })}>
              <option value="">Use scheduling settings</option>
              {current.themes.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
            </select>
          </label>
          {settings.manual && (
            <Button type="button" variant="outline" onClick={() => edit({ manual: null, automatic: true })}>Restore automatic scheduling</Button>
          )}
          <p className="text-sm text-muted-foreground">A manual theme stays active until you clear it or restore scheduling. Individual holiday toggles apply to automatic scheduling.</p>
          <fieldset className="space-y-2">
            <legend className="mb-2 font-semibold">Automatic holidays</legend>
            {current.themes.map(theme => (
              <div key={theme.id} className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={!settings.disabled.includes(theme.id)}
                    onChange={event => edit({ disabled: event.target.checked ? settings.disabled.filter(id => id !== theme.id) : [...settings.disabled, theme.id] })} />
                  {theme.name}
                </label>
                <Button type="button" size="sm" variant="outline" aria-label={`Preview ${theme.name}`} onClick={() => setPreview(theme.id)}>Preview</Button>
              </div>
            ))}
          </fieldset>
          {preview && (
            <div className="relative min-h-40 overflow-hidden rounded-lg border bg-card p-4" data-holiday={preview}>
              <p className="font-medium">{current.themes.find(theme => theme.id === preview)?.name} preview</p>
              <div className="holiday-product-image mt-2 grid h-20 w-24 place-items-center rounded bg-muted text-sm">Product</div>
              <HolidayDecorationLayer key={preview} theme={preview} animated={settings.animated} preview />
              <Button type="button" size="sm" variant="ghost" onClick={() => setPreview(null)}>Close preview</Button>
            </div>
          )}
          <Button type="submit" disabled={!edited}>{saving ? "Saving…" : "Save decorations"}</Button>
        </fieldset>
        {message && <p className="mt-2 text-sm" role={error ? "alert" : "status"}>{message}</p>}
      </form>
    </section>
  );
}
