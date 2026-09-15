import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Loader2, Printer, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";

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
      const [bridgeRows, printerRows, profileRows, templateRows] =
        await Promise.all([
          api("/api/print/bridge-profiles"),
          api("/api/print/printers"),
          api("/api/print/profiles"),
          api("/api/print/templates"),
        ]);
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
      <section className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Server size={15} />
          Bridges
        </h3>
        {bridges.map((bridge) => (
          <div
            key={bridge.id}
            className="rounded-lg border border-border/50 p-3 text-sm"
          >
            <span className="font-medium">{bridge.name}</span>
            <span className="ml-2 text-muted-foreground">
              #{bridge.id} · {bridge.bridgeType} · {bridge.routingScope}
              {bridge.locationId
                ? ` · location ${bridge.locationId}`
                : ""} · {bridge.supportedRoles} ·{" "}
              {bridge.isActive ? "active" : "inactive"}
            </span>
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
                  <option value="customer_receipt">Customer Receipt</option>
                  <option value="thank_you">Thank You</option>
                  <option value="report">Reports / Inventory Exports</option>
                </select>
              </label>
            </div>
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
