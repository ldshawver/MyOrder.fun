import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const route = readFileSync(
  resolve(root, "artifacts/api-server/src/routes/print.ts"),
  "utf8",
);
const ui = readFileSync(
  resolve(root, "artifacts/platform/src/pages/admin/registered-print.tsx"),
  "utf8",
);
const shifts = readFileSync(
  resolve(root, "artifacts/api-server/src/routes/shifts.ts"),
  "utf8",
);
const controlsUi = readFileSync(
  resolve(root, "artifacts/platform/src/pages/admin/auto-print-controls.tsx"),
  "utf8",
);
const receipts = readFileSync(
  resolve(root, "artifacts/platform/src/pages/admin/receipts.tsx"),
  "utf8",
);
const testUi = readFileSync(
  resolve(root, "artifacts/platform/src/pages/admin/document-test-print.tsx"),
  "utf8",
);
const routingUi = readFileSync(
  resolve(root, "artifacts/platform/src/pages/admin/print-routing.tsx"),
  "utf8",
);

describe("registered printer UI workflow", () => {
  it("uses the authenticated registered-printer API instead of legacy queue settings", () => {
    expect(ui).toContain("/api/print/printers");
    expect(ui).toContain("/api/print/bridge-profiles");
    expect(testUi).toContain('"/api/print/documents/test"');
    expect(routingUi).toContain('"/api/print/routes"');
    expect(ui).not.toContain("receiptPrinterName");
    expect(ui).not.toContain("local_cups");
  });

  it("wires every visible tab to a distinct accessible view state", () => {
    for (const tab of ["printers", "bridges", "routing", "layout", "automatic", "test", "reprint"]) {
      expect(receipts).toContain(`key: "${tab}"`);
    }
    expect(receipts).toContain("id={`panel-receipts-${activeTab}`}");
    expect(receipts).toContain("onClick={() => selectTab(key)}");
    expect(receipts).toContain('role="tab"');
    expect(receipts).toContain('role="tabpanel"');
    expect(receipts).toContain("window.history.replaceState");
    expect(receipts).toContain("setActiveTab(tab)");
    expect(receipts).toContain("<RegisteredPrintAdmin mode={activeTab} />");
  });

  it("shows configuration warnings only when the registered model is actually empty", () => {
    expect(receipts).not.toContain(
      "Printer hardware must be configured before live printing or routing can run",
    );
    expect(ui).toContain("bridges.length === 0 && printers.length === 0");
    expect(ui).toContain(
      "No registered printers or bridges are configured for this tenant",
    );
  });

  it("gives test printing an explicit printer, a confirmation, and visible results", () => {
    expect(testUi).toContain("disabled={busy || !printer || !confirmed}");
    expect(testUi).toContain("JSON.stringify({ documentType, printerId: printer.id, testId })");
    expect(testUi).not.toMatch(/bridgePrinterName|queue:/);
    expect(testUi).toContain('kind: "success"');
    expect(testUi).toContain('kind: "error"');
    expect(testUi).toContain('role={message.kind === "error" ? "alert" : "status"}');
  });

  it("keeps controlled test content and routing server-authoritative", () => {
    expect(route).toContain(
      "Only a testId may be supplied; content and routing are server-controlled",
    );
    expect(route).toContain("MYORDER DEV UI TEST");
    expect(route).toContain("NOT A CUSTOMER ORDER");
    expect(route).toContain("eq(printPrintersTable.tenantId, tenantId)");
    expect(route).toContain("eq(printPrintersTable.isActive, true)");
    expect(route).toContain("eq(printBridgeProfilesTable.isActive, true)");
    expect(route).toContain(
      "Location printers must be exercised through an authoritative active shift assignment",
    );
    expect(route).toContain(
      "Registered explicit queue is invalid; refusing default queue fallback",
    );
    expect(route).toContain("maxRetries: 1");
  });

  it("does not return printer or bridge credentials from list endpoints", () => {
    const printerList = route.slice(
      route.indexOf('router.get("/print/printers"'),
      route.indexOf("// Restores the one audited Mac receipt destination"),
    );
    const bridgeList = route.slice(
      route.indexOf('router.get("/print/bridge-profiles"'),
      route.indexOf("/** POST /api/print/bridge-profiles"),
    );
    expect(printerList).not.toContain("apiKey:");
    expect(printerList).not.toContain("bridgeUrl:");
    expect(bridgeList).not.toContain("apiKey:");
    expect(bridgeList).not.toContain("bridgeUrl:");
  });

  it("gates registration behind paused auto-print and never sends a bridge credential", () => {
    expect(controlsUi).toContain("!controls.autoPrintOrders && !controls.autoPrintReceipts && !controls.autoPrintLabels");
    expect(controlsUi).toContain('"/api/print/controls/pause-all"');
    expect(controlsUi).toContain('text: result.body.error ?? "Server did not confirm automatic printing is paused"');
    expect(controlsUi).toContain("return { expectedVersion: controls.version, [flag]: value };");
    expect(ui).toContain("<AutoPrintControls onChange={setAutoPrint} />");
    expect(ui.indexOf("!isAutoPrintPaused(autoPrint) ? (")).toBeLessThan(
      ui.indexOf("Register printer</h4>"),
    );
    expect(ui).not.toContain('"/api/print/settings"');
    const createBridge = ui.slice(ui.indexOf("function createBridge()"), ui.indexOf("async function probeBridge"));
    expect(createBridge).toContain("...(bridgeForm.apiKey ? { apiKey: bridgeForm.apiKey } : {})");
    expect(createBridge).not.toContain("locationId");
    const keyInput = ui.slice(ui.indexOf('aria-label="Bridge key"'), ui.indexOf("/>", ui.indexOf('aria-label="Bridge key"')));
    expect(keyInput).toContain('type="password"');
    expect(keyInput).toContain('autoComplete="new-password"');
    expect(ui).toContain('return "Bridge key must be empty or 32-256 URL-safe characters"');
    const createPrinter = ui.slice(ui.indexOf("function createPrinter()"), ui.indexOf("function setPrinterActive"));
    expect(createPrinter).toContain("JSON.stringify(printerRequestBody(printerForm))");
  });

  it("registers thermal (50/80mm) or full-page printers and adds label to routing functions", () => {
    expect(ui).toContain('export const REGISTRATION_ROLES = ["receipt", "label", "report"] as const;');
    expect(ui).toContain('printerClass: "thermal" as "thermal" | "full_page"');
    const roleSelect = ui.slice(ui.indexOf('aria-label="Printer role"'), ui.indexOf('aria-label="Printer location"'));
    expect(roleSelect).toContain('<option value="receipt">Receipt</option>');
    expect(roleSelect).toContain('<option value="label">Label</option>');
    const widthSelect = ui.slice(ui.indexOf('aria-label="Paper width"'), ui.indexOf("</select>", ui.indexOf('aria-label="Paper width"')));
    expect(widthSelect.match(/<option value=/g)).toHaveLength(2);
    expect(widthSelect).toContain('value="50mm"');
    expect(widthSelect).toContain('value="80mm"');
    const routing = ui.slice(ui.indexOf("Routing function for"), ui.indexOf("</select>", ui.indexOf("Routing function for")));
    expect(routing).toContain('<option value="label">Label</option>');
    expect(routing).toContain('<option value="receipt">Receipt (general)</option>');
    expect(ui).toContain('...(form.printerClass === "thermal" ? { paperWidth: form.paperWidth } : {})');
    expect(ui).not.toMatch(/labelWidth|labelHeight|dpi|media:/i);
  });

  it("toggles printer activation through PATCH and never deletes printers", () => {
    const toggle = ui.slice(ui.indexOf("function setPrinterActive"), ui.indexOf("function assignFunction"));
    expect(toggle).toContain('method: "PATCH"');
    expect(toggle).toContain("JSON.stringify({ isActive })");
    expect(toggle).toContain('throw new Error("Server did not confirm the printer state change")');
    expect(ui).toContain("onClick={() => void setPrinterActive(printer, !printer.isActive)}");
    expect(ui).toContain('{printer.isActive ? "Deactivate" : "Activate"}');
    expect(ui).not.toContain('method: "DELETE"');
  });

  it("does not auto-print shift documents unless receipt auto-print is enabled", () => {
    const shiftPrint = shifts.slice(
      shifts.indexOf("async function printShiftDocuments"),
      shifts.indexOf("// Always-on structured log for every shift auth decision."),
    );
    const gate = shiftPrint.indexOf("if (!(await getPrintControls(tenantId)).autoPrintReceipts) return;");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(shiftPrint.indexOf("loadShiftDocumentContext("));
    expect(gate).toBeLessThan(shiftPrint.indexOf("printClockInDocuments("));
    expect(shifts).not.toMatch(/child_process|escposPrinter|printReceiptEscPos/);
  });
});
