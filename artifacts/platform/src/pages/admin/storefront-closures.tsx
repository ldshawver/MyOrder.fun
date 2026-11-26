import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { storefrontClosureKey, type ClosureWindow } from "@/components/StorefrontClosureNotice";

type Schedule = { windows: ClosureWindow[]; version: number };
const endpoint = "/api/admin/settings/storefront-closures";
const holidayMessage = "We’re closed for the holidays. Thank you for your understanding.";

function localInput(value: string) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function StorefrontClosures() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const token = await getToken();
        if (controller.signal.aborted) return;
        const response = await fetch(endpoint, { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error("Could not load the closure schedule.");
        const data: Schedule = await response.json();
        if (!controller.signal.aborted) setSchedule(data);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load the schedule.");
      }
    })();
    return () => controller.abort();
  }, [getToken]);

  function add(closeToday: boolean) {
    if (!schedule || schedule.windows.length >= 50) return;
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setHours(24, 0, 0, 0);
    setSaved(false);
    setSchedule({ ...schedule, windows: [...schedule.windows, {
      startsAt: closeToday ? now.toISOString() : "",
      endsAt: closeToday ? tomorrow.toISOString() : "",
      message: holidayMessage,
    }] });
  }

  function edit(index: number, update: Partial<ClosureWindow>) {
    setSaved(false);
    setSchedule(current => current && ({ ...current, windows: current.windows.map((entry, i) => i === index ? { ...entry, ...update } : entry) }));
  }

  async function save() {
    if (!schedule) return;
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      const response = await fetch(endpoint, {
        method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(schedule),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save the closure schedule.");
      setSchedule(data as Schedule);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: storefrontClosureKey });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save the closure schedule.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-xl font-bold">Store closures</h1>
      <p className="text-sm text-muted-foreground">During a closure customers can browse and view existing orders. New checkout is paused.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {saved && <p role="status" className="text-sm">Closure schedule saved.</p>}
      {schedule && (
        <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-4">
          <fieldset disabled={saving} className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={schedule.windows.length >= 50} onClick={() => add(true)}>Close for the rest of today</Button>
              <Button type="button" variant="outline" disabled={schedule.windows.length >= 50} onClick={() => add(false)}>Add closure</Button>
            </div>
            <p className="text-xs text-muted-foreground">Dates and times use {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
            {schedule.windows.map((window, index) => (
              <section key={index} className="space-y-3 rounded-xl border border-border p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm">Closes
                    <Input required type="datetime-local" value={localInput(window.startsAt)}
                      onChange={event => edit(index, { startsAt: event.target.value ? new Date(event.target.value).toISOString() : "" })} />
                  </label>
                  <label className="text-sm">Reopens
                    <Input required type="datetime-local" value={localInput(window.endsAt)}
                      onChange={event => edit(index, { endsAt: event.target.value ? new Date(event.target.value).toISOString() : "" })} />
                  </label>
                </div>
                <label className="block text-sm">Popup message
                  <textarea required maxLength={500} value={window.message} rows={3}
                    className="mt-1 block w-full rounded-md border border-border bg-background p-2"
                    onChange={event => edit(index, { message: event.target.value })} />
                </label>
                <Button type="button" variant="ghost" onClick={() => {
                  setSchedule({ ...schedule, windows: schedule.windows.filter((_, i) => i !== index) });
                  setSaved(false);
                }}>Remove closure</Button>
              </section>
            ))}
            <Button type="submit">{saving ? "Saving…" : "Save closure schedule"}</Button>
          </fieldset>
        </form>
      )}
    </div>
  );
}
