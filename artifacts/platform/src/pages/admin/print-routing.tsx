import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorText, usePrintApi } from "./print-api";

type Location = { id: number | null; name: string };
type Cell = { locationId: number | null; documentType: string; printerId: number | null; printerName: string | null; bridgeName: string | null; source: string | null; problem: string | null };
type DocType = { type: string; label: string; printerClass: "thermal" | "full_page"; description: string };
type Printer = { id: number; name: string; printerClass: string; paperWidth: string; routingScope: string; locationId: number | null; isActive: boolean };
type Route = { id: number; locationId: number | null; documentType: string; printerId: number };

const SOURCE_LABEL: Record<string, string> = {
  "location-route": "Location route",
  "tenant-route": "Default route",
  "legacy-fallback": "Existing receipt printer (no route set)",
};

/** Printers that may take this document at this location (same rules the server enforces). */
export function compatiblePrinters(printers: Printer[], docType: DocType, locationId: number | null): Printer[] {
  return printers.filter((printer) =>
    printer.isActive &&
    (printer.printerClass === "full_page" ? "full_page" : "thermal") === docType.printerClass &&
    (printer.routingScope !== "location" || printer.locationId === locationId));
}

/**
 * Document routing: for each location and document type, exactly one
 * printer. A location route overrides the default route; thermal documents
 * without a route use the existing receipt printer; otherwise nothing prints.
 */
export default function PrintRouting() {
  const call = usePrintApi();
  const [locations, setLocations] = useState<Location[]>([]);
  const [cells, setCells] = useState<Cell[]>([]);
  const [docTypes, setDocTypes] = useState<DocType[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [matrix, types, printerRes, routeRes] = await Promise.all([
      call<{ locations: Location[]; cells: Cell[] }>("/api/print/routing-matrix"),
      call<{ documentTypes: DocType[] }>("/api/print/document-types"),
      call<{ printers: Printer[] }>("/api/print/printers"),
      call<{ routes: Route[] }>("/api/print/routes"),
    ]);
    if (!matrix.ok) setMessage({ kind: "error", text: errorText(matrix.body, "Could not load routing") });
    else { setLocations(matrix.body.locations); setCells(matrix.body.cells); }
    if (types.ok) setDocTypes(types.body.documentTypes);
    if (printerRes.ok) setPrinters(printerRes.body.printers);
    if (routeRes.ok) setRoutes(routeRes.body.routes.filter((route) => route.printerId));
    setLoading(false);
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const routeFor = (locationId: number | null, documentType: string) =>
    routes.find((route) => route.locationId === locationId && route.documentType === documentType);

  async function assign(locationId: number | null, docType: DocType, value: string) {
    const key = `${locationId}:${docType.type}`;
    setBusy(key);
    setMessage(null);
    const existing = routeFor(locationId, docType.type);
    const res = value === ""
      ? existing ? await call(`/api/print/routes/${existing.id}`, { method: "DELETE" }) : { ok: true, status: 200, body: {} }
      : await call("/api/print/routes", { method: "PUT", body: JSON.stringify({ documentType: docType.type, locationId, printerId: Number(value) }) });
    setMessage(res.ok ? { kind: "success", text: `${docType.label} routing updated` } : { kind: "error", text: errorText(res.body, "Routing change failed") });
    await load();
    setBusy(null);
  }

  if (loading) return <div className="text-sm text-muted-foreground"><Loader2 size={14} className="inline animate-spin mr-2" />Loading routing…</div>;

  return (
    <section className="space-y-3" data-testid="print-routing">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground max-w-prose">
          Each document prints on exactly one printer. A location route beats the default route. Reports and stock lists need a full-page printer; receipts, slips and tickets need a thermal printer.
        </p>
        <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw size={12} className="mr-1" />Refresh</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs border-collapse min-w-full">
          <thead>
            <tr>
              <th className="text-left p-2 border-b">Document</th>
              {locations.map((location) => <th key={location.id ?? "default"} className="text-left p-2 border-b whitespace-nowrap">{location.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {docTypes.map((docType) => (
              <tr key={docType.type} className="align-top">
                <td className="p-2 border-b">
                  <div className="font-medium">{docType.label}</div>
                  <div className="text-muted-foreground">{docType.printerClass === "full_page" ? "Full page (Letter)" : "Thermal"}</div>
                </td>
                {locations.map((location) => {
                  const cell = cells.find((c) => c.locationId === location.id && c.documentType === docType.type);
                  const route = routeFor(location.id, docType.type);
                  const options = compatiblePrinters(printers, docType, location.id);
                  const key = `${location.id}:${docType.type}`;
                  return (
                    <td key={key} className="p-2 border-b min-w-44">
                      <div className={cell?.printerName ? "" : "text-amber-300"}>
                        {cell?.printerName ? `${cell.printerName}${cell.bridgeName ? ` via ${cell.bridgeName}` : ""}` : "Not printed"}
                      </div>
                      <div className="text-muted-foreground">{cell?.source ? SOURCE_LABEL[cell.source] ?? cell.source : cell?.problem ?? ""}</div>
                      <select aria-label={`${docType.label} printer for ${location.name}`} className="mt-1 h-7 w-full rounded border bg-background px-1"
                        disabled={busy !== null} value={route ? String(route.printerId) : ""} onChange={(event) => void assign(location.id, docType, event.target.value)}>
                        <option value="">{location.id === null ? "No default route" : "Use default"}</option>
                        {options.map((printer) => <option key={printer.id} value={printer.id}>{printer.name}{printer.printerClass === "thermal" ? ` (${printer.paperWidth})` : ""}</option>)}
                      </select>
                      {busy === key ? <Loader2 size={12} className="inline animate-spin" /> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message ? <p className={`text-xs ${message.kind === "error" ? "text-red-300" : "text-green-300"}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p> : null}
    </section>
  );
}
