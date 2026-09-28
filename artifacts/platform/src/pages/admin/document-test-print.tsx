import { useEffect, useMemo, useState } from "react";
import { Eye, Loader2, Printer as PrinterIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorText, usePrintApi } from "./print-api";

type DocType = { type: string; label: string; printerClass: "thermal" | "full_page" };
type Printer = { id: number; name: string; printerClass: string; paperWidth: string; isActive: boolean; routingScope: string; locationId: number | null };

/**
 * Test printing: sample data only, on one explicitly chosen registered
 * printer. The server checks the printer belongs to this business, is
 * active, suits the document, and prints through its own bridge.
 */
export default function DocumentTestPrint() {
  const call = usePrintApi();
  const [docTypes, setDocTypes] = useState<DocType[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [documentType, setDocumentType] = useState("ORDER_RECEIPT");
  const [printerId, setPrinterId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<{ text?: string; pdfUrl?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const [types, printerRes] = await Promise.all([
        call<{ documentTypes: DocType[] }>("/api/print/document-types"),
        call<{ printers: Printer[] }>("/api/print/printers"),
      ]);
      if (types.ok) setDocTypes(types.body.documentTypes);
      if (printerRes.ok) setPrinters(printerRes.body.printers);
    })();
  }, [call]);

  const docType = docTypes.find((type) => type.type === documentType);
  const eligible = useMemo(() => printers.filter((printer) => printer.isActive && docType &&
    (printer.printerClass === "full_page" ? "full_page" : "thermal") === docType.printerClass), [printers, docType]);
  const printer = eligible.find((row) => String(row.id) === printerId);

  useEffect(() => { setPrinterId(""); setConfirmed(false); setPreview(null); }, [documentType]);
  useEffect(() => () => { if (preview?.pdfUrl) URL.revokeObjectURL(preview.pdfUrl); }, [preview]);

  async function showPreview() {
    setBusy(true);
    setMessage(null);
    const width = printer?.paperWidth === "50mm" || printer?.paperWidth === "58mm" ? "50mm" : "80mm";
    const res = await call<{ text?: string; blob?: Blob; error?: string }>("/api/print/documents/preview", {
      method: "POST", body: JSON.stringify({ documentType, ...(docType?.printerClass === "thermal" ? { paperWidth: width } : {}) }),
    });
    if (!res.ok) setMessage({ kind: "error", text: errorText(res.body, "Preview failed") });
    else setPreview(res.body.blob ? { pdfUrl: URL.createObjectURL(res.body.blob) } : { text: res.body.text });
    setBusy(false);
  }

  async function sendTest() {
    if (!printer || !confirmed) return;
    setBusy(true);
    setMessage(null);
    const testId = `ADMIN-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
    const res = await call<{ ok: boolean; status: string; jobId: number; error?: string }>("/api/print/documents/test", {
      method: "POST", body: JSON.stringify({ documentType, printerId: printer.id, testId }),
    });
    setMessage(res.ok && res.body.ok
      ? { kind: "success", text: `Test sent to ${printer.name}: job ${res.body.jobId} ${res.body.status}. Check the printer for the TEST PRINT.` }
      : { kind: "error", text: errorText(res.body, `Test print did not complete (${res.body.status ?? res.status})`) });
    setConfirmed(false);
    setBusy(false);
  }

  return (
    <section className="space-y-3 text-sm" data-testid="document-test-print">
      <p className="text-xs text-muted-foreground">Prints sample data marked TEST PRINT. Nothing about a real order, shift or customer is used.</p>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Document type" className="h-9 rounded border bg-background px-2" value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
          {docTypes.map((type) => <option key={type.type} value={type.type}>{type.label}</option>)}
        </select>
        <select aria-label="Test printer" className="h-9 rounded border bg-background px-2" value={printerId} onChange={(event) => { setPrinterId(event.target.value); setConfirmed(false); }}>
          <option value="">Choose a {docType?.printerClass === "full_page" ? "full-page" : "thermal"} printer…</option>
          {eligible.map((row) => <option key={row.id} value={row.id}>{row.name}{row.printerClass === "thermal" ? ` (${row.paperWidth})` : " (Letter)"}</option>)}
        </select>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void showPreview()}><Eye size={12} className="mr-1" />Preview</Button>
      </div>
      {printer ? (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          Print one test page on {printer.name}
        </label>
      ) : null}
      <Button size="sm" disabled={busy || !printer || !confirmed} onClick={() => void sendTest()}>
        {busy ? <Loader2 size={12} className="mr-1 animate-spin" /> : <PrinterIcon size={12} className="mr-1" />}Send test print
      </Button>
      {message ? <p className={`text-xs ${message.kind === "error" ? "text-red-300" : "text-green-300"}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p> : null}
      {preview?.text ? <pre className="rounded-md bg-white text-black p-3 text-[11px] leading-tight font-mono whitespace-pre overflow-x-auto max-w-full w-fit">{preview.text}</pre> : null}
      {preview?.pdfUrl ? <iframe title="Full-page preview" src={preview.pdfUrl} className="w-full h-[70vh] rounded border" /> : null}
    </section>
  );
}
