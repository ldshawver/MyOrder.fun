import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Loader2, PauseCircle, Printer, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  copies: number;
};
type AutoPrintSettings = {
  autoPrintOrders: boolean;
  autoPrintReceipts: boolean;
  autoPrintLabels: boolean;
};
type ProbeResult = { ok: boolean; httpStatus?: number; error?: string };
const BRIDGE_QUEUE_NAME = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/;
const emptyBridgeForm = { name: "", bridgeUrl: "", priority: "10", apiKey: "" };
const BRIDGE_KEY = /^[A-Za-z0-9._~+/=-]{32,256}$/;
export const REGISTRATION_ROLES = ["receipt", "label"] as const;
const emptyPrinterForm = {
  role: "receipt" as string,
  name: "",
  bridgeProfileId: "",
  bridgePrinterName: "",
  paperWidth: "80mm",
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
    return "Select receipt or label";
  if (!form.name.trim()) return "Printer name is required";
  if (!form.bridgeProfileId) return "Select an active bridge";
  if (!BRIDGE_QUEUE_NAME.test(form.bridgePrinterName.trim()))
    return "Queue name is invalid";
  const copies = Number(form.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > 5)
    return "Copies must be 1-5";
  return null;
}

type Profile = {
  id: number;
  locationId: number | null;
  shiftId: number | null;
  receiptPrinterId: number | null;
  labelPrinterId: number | null;
  expoPrinterId: number | null;
};
type Template = {
  id: number;
  name: string;
  jobType: string;
  version: number;
  isActive: boolean;
  isDefault: boolean;
};

export default function RegisteredPrintAdmin({
  mode,
}: {
  mode: "printers" | "test";
}) {
  const { getToken } = useAuth();
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [printers, setPrinters] = useState<RegisteredPrinter[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<number | null>(null);
  const [autoPrint, setAutoPrint] = useState<AutoPrintSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<number, ProbeResult>>({});
  const [bridgeForm, setBridgeForm] = useState(emptyBridgeForm);
  const [printerForm, setPrinterForm] = useState(emptyPrinterForm);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const token = await getToken();
      const response = await fetch(path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init?.headers ?? {}),
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : `HTTP ${response.status}`,
        );
      return body;
    },
    [getToken],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [bridgeRows, printerRows, profileRows, templateRows, settingsRow] =
        await Promise.all([
          api("/api/print/bridge-profiles"),
          api("/api/print/printers"),
          api("/api/print/profiles"),
          api("/api/print/templates"),
          api("/api/print/settings"),
        ]);
      const settings = settingsRow.settings ?? {};
      setAutoPrint({
        autoPrintOrders: Boolean(settings.autoPrintOrders),
        autoPrintReceipts: Boolean(settings.autoPrintReceipts),
        autoPrintLabels: Boolean(settings.autoPrintLabels),
      });
      setBridges(Array.isArray(bridgeRows) ? bridgeRows : []);
      setPrinters(
        Array.isArray(printerRows.printers) ? printerRows.printers : [],
      );
      setProfiles(
        Array.isArray(profileRows.profiles) ? profileRows.profiles : [],
      );
      setTemplates(
        Array.isArray(templateRows.templates) ? templateRows.templates : [],
      );
    } catch (error) {
      setMessage({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to load registered printing configuration",
      });
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function testPrinter(printer: RegisteredPrinter) {
    const testId = `DEV-UI-${new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14)}`;
    setTesting(printer.id);
    setMessage(null);
    try {
      const result = await api(`/api/print/printers/${printer.id}/test`, {
        method: "POST",
        body: JSON.stringify({ testId }),
      });
      setMessage({
        kind: "success",
        text: `Test print accepted: ${result.status} (${result.testId})`,
      });
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Test print failed",
      });
    } finally {
      setTesting(null);
    }
  }

  async function runAction(key: string, action: () => Promise<string>) {
    setBusy(key);
    setMessage(null);
    try {
      const text = await action();
      await load();
      setMessage({ kind: "success", text });
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Request failed",
      });
    } finally {
      setBusy(null);
    }
  }

  function pauseAutoPrint() {
    return runAction("pause", async () => {
      const result = await api("/api/print/settings", {
        method: "PATCH",
        body: JSON.stringify({
          autoPrintOrders: false,
          autoPrintReceipts: false,
          autoPrintLabels: false,
        }),
      });
      if (!isAutoPrintPaused(result.settings ?? null))
        throw new Error("Server did not confirm automatic printing is paused");
      return "Automatic printing paused";
    });
  }

  function createBridge() {
    const error = bridgeFormError(bridgeForm);
    if (error) return setMessage({ kind: "error", text: error });
    return runAction("bridge", async () => {
      // An empty key is omitted so the server uses its central credential.
      const bridge = await api("/api/print/bridge-profiles", {
        method: "POST",
        body: JSON.stringify({
          name: bridgeForm.name.trim(),
          bridgeUrl: bridgeForm.bridgeUrl.trim(),
          priority: Number(bridgeForm.priority),
          isActive: true,
          ...(bridgeForm.apiKey ? { apiKey: bridgeForm.apiKey } : {}),
        }),
      });
      setBridgeForm(emptyBridgeForm);
      return `Bridge registered (#${bridge.id})`;
    });
  }

  async function probeBridge(bridge: Bridge) {
    setBusy(`probe-${bridge.id}`);
    try {
      const result = await api(`/api/print/bridge-profiles/${bridge.id}/probe`, {
        method: "POST",
      });
      setProbes((prev) => ({ ...prev, [bridge.id]: result }));
    } catch (error) {
      setProbes((prev) => ({
        ...prev,
        [bridge.id]: {
          ok: false,
          error: error instanceof Error ? error.message : "Probe failed",
        },
      }));
    } finally {
      setBusy(null);
    }
  }

  function createPrinter() {
    const error = printerFormError(printerForm);
    if (error) return setMessage({ kind: "error", text: error });
    return runAction("printer", async () => {
      const result = await api("/api/print/printers", {
        method: "POST",
        body: JSON.stringify({
          name: printerForm.name.trim(),
          role: printerForm.role,
          connectionType: "bridge",
          bridgeProfileId: Number(printerForm.bridgeProfileId),
          bridgePrinterName: printerForm.bridgePrinterName.trim(),
          // Labels are sized by the rendered image and the CUPS queue.
          ...(printerForm.role === "receipt" ? { paperWidth: printerForm.paperWidth } : {}),
          copies: Number(printerForm.copies),
          isActive: true,
        }),
      });
      setPrinterForm(emptyPrinterForm);
      return `Printer registered (#${result.printer?.id}, ${result.printer?.role})`;
    });
  }

  function setPrinterActive(printer: RegisteredPrinter, isActive: boolean) {
    return runAction(`active-${printer.id}`, async () => {
      const result = await api(`/api/print/printers/${printer.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
      if (result.printer?.isActive !== isActive)
        throw new Error("Server did not confirm the printer state change");
      return `${printer.name} (#${printer.id}) ${isActive ? "activated" : "deactivated"}`;
    });
  }

  async function assignFunction(printer: RegisteredPrinter, role: string) {
    setMessage(null);
    try {
      await api(`/api/print/printers/${printer.id}`, { method: "PATCH", body: JSON.stringify({ role }) });
      await load();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Printer assignment failed" });
    }
  }

  if (loading)
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        <Loader2 className="inline animate-spin mr-2" size={16} />
        Loading registered printing configuration…
      </div>
    );

  return (
    <div className="space-y-5" data-testid="registered-print-admin">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Registered printing</h2>
          <p className="text-xs text-muted-foreground">
            Tenant, scope, bridge and queue are resolved and enforced by the
            server.
          </p>
        </div>
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
      {mode === "test" ? (
        <div
          className="rounded-lg border border-border/50 p-4 text-sm"
          data-testid="panel-controlled-test"
        >
          <h3 className="font-semibold">Controlled receipt test</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            The server resolves tenant, bridge and explicit queue. Only active
            general receipt printers are eligible.
          </p>
        </div>
      ) : null}
      {mode === "printers" ? (
        <section
          className="rounded-lg border border-border/50 p-4 space-y-4 text-sm"
          data-testid="panel-printer-registration"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div data-testid="auto-print-state">
              <h3 className="font-semibold">Automatic printing</h3>
              <p className="text-xs text-muted-foreground">
                Orders {autoPrint?.autoPrintOrders ? "on" : "off"} · Receipts{" "}
                {autoPrint?.autoPrintReceipts ? "on" : "off"} · Labels{" "}
                {autoPrint?.autoPrintLabels ? "on" : "off"}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || isAutoPrintPaused(autoPrint)}
              onClick={() => void pauseAutoPrint()}
            >
              <PauseCircle size={13} className="mr-1" />
              Pause all automatic printing
            </Button>
          </div>
          {!isAutoPrintPaused(autoPrint) ? (
            <p className="text-xs text-amber-300" role="status">
              Pause automatic printing before registering printers so a new
              printer cannot start printing orders or shift reports.
            </p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <h4 className="font-medium">Register bridge</h4>
                <Input
                  aria-label="Bridge name"
                  placeholder="Name"
                  value={bridgeForm.name}
                  onChange={(e) => setBridgeForm({ ...bridgeForm, name: e.target.value })}
                />
                <Input
                  aria-label="Bridge URL"
                  placeholder="http://host:3100"
                  value={bridgeForm.bridgeUrl}
                  onChange={(e) => setBridgeForm({ ...bridgeForm, bridgeUrl: e.target.value })}
                />
                <Input
                  aria-label="Bridge priority"
                  inputMode="numeric"
                  value={bridgeForm.priority}
                  onChange={(e) => setBridgeForm({ ...bridgeForm, priority: e.target.value })}
                />
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
                  General scope. Leave the key empty to use the server's central
                  bridge credential. A key entered here is never shown again.
                </p>
                <Button size="sm" disabled={busy !== null} onClick={() => void createBridge()}>
                  Register bridge
                </Button>
              </div>
              <div className="space-y-2">
                <h4 className="font-medium">Register printer</h4>
                <select
                  aria-label="Printer role"
                  className="h-9 w-full rounded border bg-background px-2"
                  value={printerForm.role}
                  onChange={(e) => setPrinterForm({ ...printerForm, role: e.target.value })}
                >
                  <option value="receipt">Receipt</option>
                  <option value="label">Label</option>
                </select>
                <Input
                  aria-label="Printer name"
                  placeholder="Name"
                  value={printerForm.name}
                  onChange={(e) => setPrinterForm({ ...printerForm, name: e.target.value })}
                />
                <select
                  aria-label="Printer bridge"
                  className="h-9 w-full rounded border bg-background px-2"
                  value={printerForm.bridgeProfileId}
                  onChange={(e) => setPrinterForm({ ...printerForm, bridgeProfileId: e.target.value })}
                >
                  <option value="">Select bridge…</option>
                  {bridges
                    .filter((bridge) => bridge.isActive && bridge.routingScope === "general")
                    .map((bridge) => (
                      <option key={bridge.id} value={bridge.id}>
                        {bridge.name} (#{bridge.id})
                      </option>
                    ))}
                </select>
                <Input
                  aria-label="Bridge queue name"
                  placeholder="CUPS queue, e.g. Brightek_POS80"
                  value={printerForm.bridgePrinterName}
                  onChange={(e) => setPrinterForm({ ...printerForm, bridgePrinterName: e.target.value })}
                />
                <div className="flex gap-2">
                  {printerForm.role === "receipt" ? (
                    <select
                      aria-label="Paper width"
                      className="h-9 rounded border bg-background px-2"
                      value={printerForm.paperWidth}
                      onChange={(e) => setPrinterForm({ ...printerForm, paperWidth: e.target.value })}
                    >
                      <option value="80mm">80mm</option>
                      <option value="58mm">58mm</option>
                    </select>
                  ) : null}
                  <Input
                    aria-label="Copies"
                    inputMode="numeric"
                    value={printerForm.copies}
                    onChange={(e) => setPrinterForm({ ...printerForm, copies: e.target.value })}
                  />
                </div>
                <Button size="sm" disabled={busy !== null} onClick={() => void createPrinter()}>
                  Register printer
                </Button>
              </div>
            </div>
          )}
        </section>
      ) : null}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Server size={15} />
          Bridges
        </h3>
        {bridges.map((bridge) => (
          <div
            key={bridge.id}
            className="rounded-lg border border-border/50 p-3 text-sm flex flex-wrap items-center justify-between gap-2"
          >
            <div>
              <span className="font-medium">{bridge.name}</span>
              <span className="ml-2 text-muted-foreground">
                #{bridge.id} · {bridge.bridgeType} · {bridge.routingScope}
                {bridge.locationId
                  ? ` · location ${bridge.locationId}`
                  : ""} · {bridge.supportedRoles} ·{" "}
                {bridge.isActive ? "active" : "inactive"}
              </span>
              {probes[bridge.id] ? (
                <div
                  className={`text-xs ${probes[bridge.id].ok ? "text-green-300" : "text-red-300"}`}
                  role="status"
                >
                  Probe {probes[bridge.id].ok ? "ok" : "failed"}
                  {probes[bridge.id].httpStatus ? ` · HTTP ${probes[bridge.id].httpStatus}` : ""}
                  {probes[bridge.id].error ? ` · ${probes[bridge.id].error}` : ""}
                </div>
              ) : null}
            </div>
            {mode === "printers" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void probeBridge(bridge)}
              >
                {busy === `probe-${bridge.id}` ? (
                  <Loader2 size={13} className="animate-spin mr-1" />
                ) : null}
                Probe
              </Button>
            ) : null}
          </div>
        ))}
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Printer size={15} />
          Printers
        </h3>
        {printers.map((printer) => (
          <div
            key={printer.id}
            className="rounded-lg border border-border/50 p-3 flex items-center justify-between gap-3"
          >
            <div className="text-sm">
              <div className="font-medium">{printer.name}</div>
              <div className="text-xs text-muted-foreground">
                #{printer.id} · {printer.role} · {printer.routingScope}
                {printer.locationId
                  ? ` · location ${printer.locationId}`
                  : ""}{" "}
                · bridge #{printer.bridgeProfileId ?? "none"} · queue{" "}
                {printer.bridgePrinterName ?? "invalid/unset"} ·{" "}
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
            {mode === "printers" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void setPrinterActive(printer, !printer.isActive)}
              >
                {busy === `active-${printer.id}` ? (
                  <Loader2 size={13} className="animate-spin mr-1" />
                ) : null}
                {printer.isActive ? "Deactivate" : "Activate"}
              </Button>
            ) : null}
            {mode === "test" &&
            printer.role === "receipt" &&
            printer.routingScope === "general" &&
            printer.isActive ? (
              <Button
                size="sm"
                variant="outline"
                disabled={testing !== null}
                onClick={() => void testPrinter(printer)}
              >
                {testing === printer.id ? (
                  <Loader2 size={13} className="animate-spin mr-1" />
                ) : null}
                Controlled UI test
              </Button>
            ) : null}
          </div>
        ))}
      </section>
      <div className="grid md:grid-cols-2 gap-3 text-xs text-muted-foreground">
        <div className="rounded-lg border border-border/50 p-3">
          Print profiles: {profiles.length}
        </div>
        <div className="rounded-lg border border-border/50 p-3">
          Templates: {templates.length} (
          {templates.filter((template) => template.isActive).length} active)
        </div>
      </div>
    </div>
  );
}
