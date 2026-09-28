import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Loader2, PauseCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export type PrintControls = {
  autoPrintOrders: boolean;
  autoPrintReceipts: boolean;
  autoPrintLabels: boolean;
  version: number;
};
type Flag = "autoPrintOrders" | "autoPrintReceipts" | "autoPrintLabels";

export const AUTO_PRINT_FLAGS: Array<{ flag: Flag; label: string; detail: string }> = [
  { flag: "autoPrintOrders", label: "Order and expo tickets", detail: "Print when an order is placed" },
  { flag: "autoPrintReceipts", label: "Customer receipts and shift slips", detail: "Order receipts, clock-in/out and shift documents" },
  { flag: "autoPrintLabels", label: "Delivery thank-you labels", detail: "Labels for eligible delivery orders" },
];

/** Body for changing one flag: only that flag plus the version it was loaded at. */
export function controlChange(controls: PrintControls, flag: Flag, value: boolean) {
  return { expectedVersion: controls.version, [flag]: value };
}

export function allPaused(controls: PrintControls | null) {
  return Boolean(controls && !controls.autoPrintOrders && !controls.autoPrintReceipts && !controls.autoPrintLabels);
}

/**
 * Per-tenant automatic printing. Each toggle sends only its own flag with the
 * version it was loaded at, so a stale screen can never re-enable another
 * flag; the server refuses (409) and the screen reloads instead.
 */
export default function AutoPrintControls({ onChange }: { onChange?: (controls: PrintControls) => void }) {
  const { getToken } = useAuth();
  const [controls, setControls] = useState<PrintControls | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    const token = await getToken();
    const response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  }, [getToken]);

  const apply = useCallback((next: PrintControls) => {
    setControls(next);
    onChange?.(next);
  }, [onChange]);

  const load = useCallback(async () => {
    const result = await call("/api/print/controls");
    if (result.ok) apply(result.body.controls);
    else setMessage({ kind: "error", text: result.body.error ?? `Could not load automatic printing (HTTP ${result.status})` });
  }, [apply, call]);

  useEffect(() => { void load(); }, [load]);

  async function toggle(flag: Flag, value: boolean) {
    if (!controls) return;
    setBusy(true);
    setMessage(null);
    const result = await call("/api/print/controls", { method: "PATCH", body: JSON.stringify(controlChange(controls, flag, value)) });
    if (result.ok) {
      apply(result.body.controls);
    } else if (result.status === 409) {
      apply(result.body.controls);
      setMessage({ kind: "error", text: "Someone changed automatic printing since this page loaded. Nothing was changed; the current settings are shown." });
    } else {
      setMessage({ kind: "error", text: result.body.error ?? "Change failed" });
    }
    setBusy(false);
  }

  async function pauseAll() {
    setBusy(true);
    setMessage(null);
    const result = await call("/api/print/controls/pause-all", { method: "POST", body: "{}" });
    if (result.ok && allPaused(result.body.controls)) {
      apply(result.body.controls);
      setMessage({ kind: "success", text: "All automatic printing is paused" });
    } else {
      setMessage({ kind: "error", text: result.body.error ?? "Server did not confirm automatic printing is paused" });
    }
    setBusy(false);
  }

  if (!controls) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="auto-print-controls-loading">
        <Loader2 size={14} className="inline animate-spin mr-2" />Loading automatic printing…
        {message ? <p className="text-red-300 mt-2" role="alert">{message.text}</p> : null}
      </div>
    );
  }

  return (
    <section className="space-y-3" data-testid="auto-print-controls">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Automatic printing</h3>
          <p className="text-xs text-muted-foreground">
            Applies to this business only. Off unless turned on here.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={busy || allPaused(controls)} onClick={() => void pauseAll()}>
          <PauseCircle size={13} className="mr-1" />
          Pause all automatic printing
        </Button>
      </div>
      {AUTO_PRINT_FLAGS.map(({ flag, label, detail }) => (
        <label key={flag} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 p-3 text-sm">
          <span>
            <span className="font-medium">{label}</span>
            <span className="block text-xs text-muted-foreground">{detail}</span>
          </span>
          <input
            type="checkbox"
            aria-label={label}
            className="h-4 w-4"
            checked={controls[flag]}
            disabled={busy}
            onChange={(event) => void toggle(flag, event.target.checked)}
          />
        </label>
      ))}
      {message ? (
        <p className={`text-xs ${message.kind === "error" ? "text-red-300" : "text-green-300"}`} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
