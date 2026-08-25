import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const source = readFileSync(
  resolve(root, "artifacts/api-server/src/routes/print.ts"),
  "utf8",
);
const setup = source.slice(
  source.indexOf('router.post(\n  "/print/setup/inactive-mac-receipt"'),
  source.indexOf("const VALID_ROLES"),
);

describe("inactive Mac receipt setup", () => {
  it("is staging-only, approved-admin-only, server-tenant-scoped, and rejects browser ownership input", () => {
    expect(setup).toContain('process.env.NODE_ENV !== "staging"');
    expect(setup).toContain('req.get("X-MyOrder-Environment") !== "staging"');
    expect(setup).toContain("adminOnly");
    expect(setup).toContain("requestTenantId(req)");
    expect(source).toContain("z.object({}).strict()");
    for (const forbidden of [
      "tenantId",
      "actorId",
      "actorRole",
      "role",
      "permission",
      "locationId",
    ]) {
      expect(inactiveMacReceiptSetupBody()).not.toContain(`${forbidden}:`);
    }
  });

  it("restores only the fixed inactive receipt bridge and printer identity", () => {
    expect(source).toContain('bridgeName: "Mac Studio receipt bridge"');
    expect(source).toContain('bridgeUrl: "http://100.104.253.117:3100"');
    expect(source).toContain('printerName: "Caysn POS80 1.0"');
    expect(source).toContain('queue: "Brightek_POS80"');
    expect(source).toContain(
      'deviceUri: "usb://Brightek/POS80?serial=MHTP80E"',
    );
    expect(setup).toContain('role: "receipt"');
    expect(setup).toContain('connectionType: "mac_bridge"');
    expect(setup).toContain("isActive: false");
    expect(setup).toContain("receiptCapable: true");
    expect(setup).toContain("labelCapable: false");
    expect(setup).toContain("expectedDeviceUriHash");
  });

  it("is transactional and idempotent without creating routes, assignments, profiles, or jobs", () => {
    expect(setup).toMatch(/db\s*\.transaction\(async \(tx\)/);
    expect(setup).toContain("pg_advisory_xact_lock");
    expect(setup).toContain('req.get("Idempotency-Key")');
    expect(setup).toContain("replayed: !changed");
    expect(setup).not.toContain("tx.insert(printRoutesTable)");
    expect(setup).not.toContain("tx.insert(operatorPrintProfilesTable)");
    expect(setup).not.toContain("tx.insert(shiftPrintAssignmentsTable)");
    expect(setup).not.toContain("tx.insert(printJobsTable)");
    expect(setup).not.toContain("dispatchJob(");
    expect(setup).not.toContain("probePrinter(");
    expect(setup).not.toContain("MARKLIFE");
  });

  it("rejects an existing route and returns only non-sensitive setup results", () => {
    expect(setup).toContain('throw new Error("MAC_RECEIPT_PRINTER_HAS_ROUTE")');
    expect(setup).toContain("bridgeId: result.bridge.id");
    expect(setup).toContain("printerId: result.printer.id");
    expect(setup).toContain("bridgeActive: false");
    expect(setup).toContain("printerActive: false");
    expect(setup).toContain("routeCount: 0");
    const response = setup.slice(
      setup.lastIndexOf("res.status(result.replayed"),
    );
    for (const secret of [
      "apiKey",
      "bridgeUrl",
      "deviceUri",
      "tenantId",
      "actorId",
    ]) {
      expect(response).not.toContain(secret);
    }
  });
});

function inactiveMacReceiptSetupBody(): string {
  const start = source.indexOf("const inactiveMacReceiptSetupBody");
  const end = source.indexOf("const INACTIVE_MAC_RECEIPT");
  return source.slice(start, end);
}
