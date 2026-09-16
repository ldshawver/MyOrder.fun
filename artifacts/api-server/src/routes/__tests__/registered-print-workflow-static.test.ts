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
const receipts = readFileSync(
  resolve(root, "artifacts/platform/src/pages/admin/receipts.tsx"),
  "utf8",
);

describe("registered printer UI workflow", () => {
  it("uses the authenticated registered-printer API instead of legacy queue settings", () => {
    expect(ui).toContain("/api/print/printers");
    expect(ui).toContain("/api/print/bridge-profiles");
    expect(ui).toContain("/api/print/printers/${printer.id}/test");
    expect(ui).not.toContain("receiptPrinterName");
    expect(ui).not.toContain("local_cups");
  });

  it("wires every visible tab to a distinct accessible view state", () => {
    for (const tab of ["reprint", "templates", "printers", "routing", "test"]) {
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

  it("gives the controlled test visible pending, success, and error states", () => {
    expect(ui).toContain("disabled={testing !== null}");
    expect(ui).toContain('kind: "success"');
    expect(ui).toContain('kind: "error"');
    expect(ui).toContain(
      'role={message.kind === "error" ? "alert" : "status"}',
    );
    expect(ui).toContain("Test print accepted:");
    expect(ui).toContain("Test print failed");
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
});
