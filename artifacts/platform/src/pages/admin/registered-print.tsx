import { useCallback, useEffect, useState } from "react";
import { Loader2, Printer, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AutoPrintControls from "./auto-print-controls";
import { errorText, usePrintApi } from "./print-api";

type Bridge = {
  id: number;
  locationId: number | null;
  routingScope: string;
  name: string;
  bridgeType: string;
  isActive: boolean;
  priority: number;
  supportedRoles: string;
};
type RegisteredPrinter = {
  id: number;
  locationId: number | null;
  routingScope: string;
  name: string;
  role: string;
  connectionType: string;
  bridgeProfileId: number | null;
  bridgePrinterName: string | null;
  isActive: boolean;
  paperWidth: string;
  printerClass: string;
  copies: number;
};
type Location = { id: number | null; name: string };
type AutoPrintSettings = {
  autoPrintOrders: boolean;
  autoPrintReceipts: boolean;
  autoPrintLabels: boolean;
};
type ProbeResult = { ok: boolean; httpStatus?: number; error?: string };

const BRIDGE_QUEUE_NAME = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/;
const BRIDGE_KEY = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const emptyBridgeForm = { name: "", bridgeUrl: "", priority: "10", apiKey: "" };
export const REGISTRATION_ROLES = ["receipt", "label", "report"] as const;
const emptyPrinterForm = {
  role: "receipt" as string,
  printerClass: "thermal" as "thermal" | "full_page",
  paperWidth: "80mm" as "50mm" | "80mm",
  locationId: "",
  name: "",
  bridgeProfileId: "",
  bridgePrinterName: "",
  copies: "1",
};

export function isAutoPrintPaused(settings: AutoPrintSettings | null) {
  return Boolean(
    settings &&
      !settings.autoPrintOrders &&
      !settings.autoPrintReceipts &&
      !settings.autoPrintLabels,
  );
}

export function bridgeFormError(form: typeof emptyBridgeForm) {
  if (!form.name.trim()) return "Bridge name is required";
  try {
    const url = new URL(form.bridgeUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "Bridge URL must be http(s)";
  } catch {
    return "Bridge URL must be http(s)";
  }
  if (!Number.isInteger(Number(form.priority))) return "Priority must be a whole number";
  if (form.apiKey && !BRIDGE_KEY.test(form.apiKey))
    return "Bridge key must be empty or 32-256 URL-safe characters";
  return null;
}

export function printerFormError(form: typeof emptyPrinterForm) {
  if (!(REGISTRATION_ROLES as readonly string[]).includes(form.role))
    return "Select receipt, label or report";
  if (!form.name.trim()) return "Printer name is required";
  if (!form.bridgeProfileId) return "Select an active bridge";
  if (!BRIDGE_QUEUE_NAME.test(form.bridgePrinterName.trim()))
    return "Queue name is invalid";
  if (form.printerClass === "thermal" && form.paperWidth !== "50mm" && form.paperWidth !== "80mm")
    return "Thermal printers are 50mm or 80mm";
  const copies = Number(form.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > 5)
    return "Copies must be 1-5";
  return null;
}

/** Request body for registering a printer; full-page printers never send a roll width. */
export function printerRequestBody(form: typeof emptyPrinterForm) {
  return {
    name: form.name.trim(),
    role: form.role,
    connectionType: "bridge",
    printerClass: form.printerClass,
    ...(form.printerClass === "thermal" ? { paperWidth: form.paperWidth } : {}),
    ...(form.locationId ? { locationId: Number(form.locationId) } : {}),
    bridgeProfileId: Number(form.bridgeProfileId),
    bridgePrinterName: form.bridgePrinterName.trim(),
    copies: Number(form.copies),
    isActive: true,
  };
}

const selectClass = "h-9 w-full rounded border bg-background px-2";

/**
 * Printers and bridges. Tenant, scope, bridge credentials and queues are
 * resolved and enforced by the server; this screen only submits ids and
 * plain values. Printers are never deleted, only activated or deactivated.
 */
export default function RegisteredPrintAdmin({ mode }: { mode: "printers" | "bridges" }) {
  const api = usePrintApi();
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [printers, setPrinters] = useState<RegisteredPrinter[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoPrint, setAutoPrint] = useState<AutoPrintSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<number, ProbeResult>>({});
  const [bridgeForm, setBridgeForm] = useState(emptyBridgeForm);
  const [printerForm, setPrinterForm] = useState(emptyPrinterForm);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [bridgeRes, printerRes, matrixRes] = await Promise.all([
      api<Bridge[]>("/api/print/bridge-profiles"),
      api<{ printers: RegisteredPrinter[] }>("/api/print/printers"),
      api<{ locations: Location[] }>("/api/print/routing-matrix"),
    ]);
    if (!bridgeRes.ok || !printerRes.ok) {
      setMessage({ kind: "error", text: errorText(bridgeRes.ok ? printerRes.body : bridgeRes.body, "Failed to load printers and bridges") });
    }
    setBridges(Array.isArray(bridgeRes.body) ? bridgeRes.body : []);
    setPrinters(Array.isArray(printerRes.body.printers) ? printerRes.body.printers : []);
    setLocations(matrixRes.ok ? matrixRes.body.locations.filter((location) => location.id !== null) : []);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runAction(key: string, action: () => Promise<string>) {
    setBusy(key);
    setMessage(null);
    try {
      const text = await action();
      await load();
      setMessage({ kind: "success", text });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Request failed" });
    } finally {
      setBusy(null);
    }
  }

  const expect = async <T,>(promise: Promise<{ ok: boolean; body: T }>, fallback: string): Promise<T> => {
    const res = await promise;
    if (!res.ok) throw new Error(errorText(res.body, fallback));
    return res.body;
  };

  function createBridge() {
    const error = bridgeFormError(bridgeForm);
    if (error) return setMessage({ kind: "error", text: error });
    return runAction("bridge", async () => {
      // An empty key is omitted so the server uses its central credential.
      const bridge = await expect(api<{ id: number }>("/api/print/bridge-profiles", {
        method: "POST",
        body: JSON.stringify({
          name: bridgeForm.name.trim(),
          bridgeUrl: bridgeForm.bridgeUrl.trim(),
          priority: Number(bridgeForm.priority),
          isActive: true,
          ...(bridgeForm.apiKey ? { apiKey: bridgeForm.apiKey } : {}),
        }),
      }), "Bridge registration failed");
      setBridgeForm(emptyBridgeForm);
      return `Bridge registered (#${bridge.id})`;
    });
  }

  async function probeBridge(bridge: Bridge) {
    setBusy(`probe-${bridge.id}`);
    const res = await api<ProbeResult>(`/api/print/bridge-profiles/${bridge.id}/probe`, { method: "POST" });
    setProbes((prev) => ({ ...prev, [bridge.id]: res.ok ? res.body : { ok: false, error: errorText(res.body, "Probe failed") } }));
    setBusy(null);
  }

  function createPrinter() {
    const error = printerFormError(printerForm);
    if (error) return setMessage({ kind: "error", text: error });
    return runAction("printer", async () => {
      const result = await expect(api<{ printer: RegisteredPrinter }>("/api/print/printers", {
        method: "POST",
        body: JSON.stringify(printerRequestBody(printerForm)),
      }), "Printer registration failed");
      setPrinterForm(emptyPrinterForm);
      return `Printer registered (#${result.printer.id})`;
    });
  }

  function setPrinterActive(printer: RegisteredPrinter, isActive: boolean) {
    return runAction(`active-${printer.id}`, async () => {
      const result = await expect(api<{ printer: RegisteredPrinter }>(`/api/print/printers/${printer.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      }), "Printer update failed");
      if (result.printer?.isActive !== isActive)
        throw new Error("Server did not confirm the printer state change");
      return `${printer.name} (#${printer.id}) ${isActive ? "activated" : "deactivated"}`;
    });
  }

  function assignFunction(printer: RegisteredPrinter, role: string) {
    return runAction(`role-${printer.id}`, async () => {
      await expect(api(`/api/print/printers/${printer.id}`, { method: "PATCH", body: JSON.stringify({ role }) }), "Printer assignment failed");
      return `${printer.name} function updated`;
    });
  }

  const bridgeName = (id: number | null) => bridges.find((bridge) => bridge.id === id)?.name ?? (id ? `#${id}` : "none");
  const locationName = (id: number | null) => (id === null ? "All locations" : locations.find((location) => location.id === id)?.name ?? `Location #${id}`);

  if (loading)
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        <Loader2 className="inline animate-spin mr-2" size={16} />
        Loading printers and bridges…
      </div>
    );

  return (
    <div className="space-y-5" data-testid="registered-print-admin">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Tenant, location, bridge and queue are resolved and enforced by the server.
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw size={13} className="mr-1" />
          Refresh
        </Button>
      </div>
      {message && (
        <div
          className={`rounded-lg border p-3 text-sm ${message.kind === "error" ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-green-500/40 bg-green-500/10 text-green-300"}`}
          role={message.kind === "error" ? "alert" : "status"}
          data-testid="registered-print-message"
        >
          {message.text}
        </div>
      )}
      {!message && bridges.length === 0 && printers.length === 0 ? (
        <div
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
          role="status"
          data-testid="printer-configuration-warning"
        >
          No registered printers or bridges are configured for this tenant.
        </div>
      ) : null}

      {mode === "bridges" ? (
        <>
          <section className="rounded-lg border border-border/50 p-4 space-y-2 text-sm max-w-xl" data-testid="panel-bridge-registration">
            <h3 className="font-semibold">Register bridge</h3>
            <Input aria-label="Bridge name" placeholder="Name, e.g. Raspberry Pi - Box 2" value={bridgeForm.name} onChange={(e) => setBridgeForm({ ...bridgeForm, name: e.target.value })} />
            <Input aria-label="Bridge URL" placeholder="http://100.x.y.z:3100 (Tailscale)" value={bridgeForm.bridgeUrl} onChange={(e) => setBridgeForm({ ...bridgeForm, bridgeUrl: e.target.value })} />
            <Input aria-label="Bridge priority" inputMode="numeric" value={bridgeForm.priority} onChange={(e) => setBridgeForm({ ...bridgeForm, priority: e.target.value })} />
            <Input
              aria-label="Bridge key"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder="Bridge key (optional)"
              value={bridgeForm.apiKey}
              onChange={(e) => setBridgeForm({ ...bridgeForm, apiKey: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Leave the key empty to use the server's central bridge credential. A key entered here is never shown again.
            </p>
            <Button size="sm" disabled={busy !== null} onClick={() => void createBridge()}>
              Register bridge
            </Button>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-2"><Server size={15} />Bridges</h3>
            {bridges.map((bridge) => (
              <div key={bridge.id} className="rounded-lg border border-border/50 p-3 text-sm flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{bridge.name}</span>
                  <span className="ml-2 text-muted-foreground">
                    #{bridge.id} · {bridge.routingScope}
                    {bridge.locationId ? ` · ${locationName(bridge.locationId)}` : ""} · priority {bridge.priority} ·{" "}
                    {bridge.isActive ? "active" : "inactive"}
                  </span>
                  {probes[bridge.id] ? (
                    <div className={`text-xs ${probes[bridge.id].ok ? "text-green-300" : "text-red-300"}`} role="status">
                      Probe {probes[bridge.id].ok ? "ok" : "failed"}
                      {probes[bridge.id].httpStatus ? ` · HTTP ${probes[bridge.id].httpStatus}` : ""}
                      {probes[bridge.id].error ? ` · ${probes[bridge.id].error}` : ""}
                    </div>
                  ) : null}
                </div>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void probeBridge(bridge)}>
                  {busy === `probe-${bridge.id}` ? <Loader2 size={13} className="animate-spin mr-1" /> : null}
                  Probe
                </Button>
              </div>
            ))}
          </section>
        </>
      ) : null}

      {mode === "printers" ? (
        <>
          <section className="rounded-lg border border-border/50 p-4 space-y-4 text-sm" data-testid="panel-printer-registration">
            <div data-testid="auto-print-state">
              <AutoPrintControls onChange={setAutoPrint} />
            </div>
            {!isAutoPrintPaused(autoPrint) ? (
              <p className="text-xs text-amber-300" role="status">
                Pause automatic printing before registering printers so a new
                printer cannot start printing orders or shift documents.
              </p>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 max-w-3xl">
                <h4 className="font-medium md:col-span-2">Register printer</h4>
                <Input aria-label="Printer name" placeholder="Name, e.g. Box 2 Receipt" value={printerForm.name} onChange={(e) => setPrinterForm({ ...printerForm, name: e.target.value })} />
                <select aria-label="Printer class" className={selectClass} value={printerForm.printerClass}
                  onChange={(e) => setPrinterForm({ ...printerForm, printerClass: e.target.value as "thermal" | "full_page", role: e.target.value === "full_page" ? "report" : "receipt" })}>
                  <option value="thermal">Thermal (receipt roll)</option>
                  <option value="full_page">Full page (US Letter)</option>
                </select>
                {printerForm.printerClass === "thermal" ? (
                  <select aria-label="Paper width" className={selectClass} value={printerForm.paperWidth} onChange={(e) => setPrinterForm({ ...printerForm, paperWidth: e.target.value as "50mm" | "80mm" })}>
                    <option value="80mm">80mm roll</option>
                    <option value="50mm">50mm roll</option>
                  </select>
                ) : (
                  <div className="text-xs text-muted-foreground self-center">Prints US Letter (8.5 × 11 in)</div>
                )}
                <select aria-label="Printer role" className={selectClass} value={printerForm.role} onChange={(e) => setPrinterForm({ ...printerForm, role: e.target.value })}>
                  <option value="receipt">Receipt</option>
                  <option value="label">Label</option>
                  <option value="report">Report</option>
                </select>
                <select aria-label="Printer location" className={selectClass} value={printerForm.locationId} onChange={(e) => setPrinterForm({ ...printerForm, locationId: e.target.value })}>
                  <option value="">All locations (general)</option>
                  {locations.map((location) => <option key={location.id} value={String(location.id)}>{location.name}</option>)}
                </select>
                <select aria-label="Printer bridge" className={selectClass} value={printerForm.bridgeProfileId} onChange={(e) => setPrinterForm({ ...printerForm, bridgeProfileId: e.target.value })}>
                  <option value="">Select bridge…</option>
                  {bridges.filter((bridge) => bridge.isActive && bridge.routingScope === "general").map((bridge) => (
                    <option key={bridge.id} value={bridge.id}>{bridge.name} (#{bridge.id})</option>
                  ))}
                </select>
                <Input aria-label="Bridge queue name" placeholder="CUPS queue, e.g. Brightek_POS80" value={printerForm.bridgePrinterName} onChange={(e) => setPrinterForm({ ...printerForm, bridgePrinterName: e.target.value })} />
                <Input aria-label="Copies" inputMode="numeric" value={printerForm.copies} onChange={(e) => setPrinterForm({ ...printerForm, copies: e.target.value })} />
                <div className="md:col-span-2">
                  <Button size="sm" disabled={busy !== null} onClick={() => void createPrinter()}>Register printer</Button>
                </div>
              </div>
            )}
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-2"><Printer size={15} />Printers</h3>
            {printers.map((printer) => (
              <div key={printer.id} className="rounded-lg border border-border/50 p-3 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm">
                  <div className="font-medium">{printer.name}</div>
                  <div className="text-xs text-muted-foreground">
                    #{printer.id} · {printer.printerClass === "full_page" ? "Full page (Letter)" : `Thermal ${printer.paperWidth}`} · {locationName(printer.locationId)}
                    {" "}· via {bridgeName(printer.bridgeProfileId)} · queue {printer.bridgePrinterName ?? "invalid/unset"} ·{" "}
                    {printer.isActive ? "active" : "inactive"}
                  </div>
                  <label className="mt-2 block text-xs text-muted-foreground">Routing function
                    <select aria-label={`Routing function for ${printer.name}`} className="ml-2 h-7 rounded border bg-background px-1" value={printer.role} onChange={event => void assignFunction(printer, event.target.value)}>
                      <option value="unassigned">Unassigned</option>
                      <option value="receipt">Receipt (general)</option>
                      <option value="customer_receipt">Customer Receipt</option>
                      <option value="label">Label</option>
                      <option value="thank_you">Thank You</option>
                      <option value="report">Reports / Inventory Exports</option>
                    </select>
                  </label>
                </div>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void setPrinterActive(printer, !printer.isActive)}>
                  {busy === `active-${printer.id}` ? <Loader2 size={13} className="animate-spin mr-1" /> : null}
                  {printer.isActive ? "Deactivate" : "Activate"}
                </Button>
              </div>
            ))}
          </section>
        </>
      ) : null}
    </div>
  );
}
