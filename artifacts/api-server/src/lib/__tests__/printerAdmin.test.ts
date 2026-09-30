/**
 * Operator path for printer registration: admin authorization, the bridge's
 * own queue allowlist, and the paper rules shared with the admin routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ users: [] as Array<Record<string, unknown>>, bridges: [] as Array<Record<string, unknown>>, printers: [] as Array<Record<string, unknown>>, audits: [] as Array<Record<string, unknown>>, locations: [] as Array<Record<string, unknown>> }));

vi.mock("@workspace/db", () => {
  const select = vi.fn(() => ({
    from: (table: { name: string }) => ({
      where: (predicates: Array<{ column: string; value: unknown }> | { column: string; value: unknown }) => ({
        limit: async () => {
          const list = Array.isArray(predicates) ? predicates : [predicates];
          const source = ({ users: rows.users, printers: rows.printers, locations: rows.locations, bridges: rows.bridges } as Record<string, Array<Record<string, unknown>>>)[table.name]!;
          return source.filter((row) => list.every(({ column, value }) => row[column] === value));
        },
      }),
    }),
  }));
  const matches = (row: Record<string, unknown>, predicates: Array<{ column: string; value: unknown }>) => predicates.every(({ column, value }) => row[column] === value);
  const tableRows = (table: { name: string }) => (table.name === "printers" ? rows.printers : rows.bridges);
  const update = vi.fn((table: { name: string }) => ({
    set: (values: Record<string, unknown>) => ({
      where: (predicates: Array<{ column: string; value: unknown }>) => {
        const changed = tableRows(table).filter((row) => matches(row, predicates)).map((row) => Object.assign(row, values));
        return Object.assign(Promise.resolve(changed), { returning: async () => changed });
      },
    }),
  }));
  const insert = vi.fn((table: { name: string }) => ({
    values: (values: Record<string, unknown>) => {
      if (table.name === "audits") { rows.audits.push(values); return Promise.resolve([]); }
      const row = { id: 100 + rows.bridges.length, ...values };
      rows.bridges.push(row);
      return { returning: async () => [row] };
    },
  }));
  return {
    db: { select, update, insert },
    usersTable: { name: "users", id: "id" },
    printBridgeProfilesTable: { name: "bridges", id: "id", tenantId: "tenantId", isActive: "isActive", locationId: "locationId", bridgeUrl: "bridgeUrl" },
    printPrintersTable: { name: "printers", id: "id", tenantId: "tenantId", bridgeProfileId: "bridgeProfileId", isActive: "isActive" },
    printRoutesTable: {},
    inventoryLocationsTable: { name: "locations", id: "id", tenantId: "tenantId", isActive: "isActive" },
    auditLogsTable: { name: "audits" },
  };
});
vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown) => ({ column, value }),
  and: (...predicates: unknown[]) => predicates,
  isNull: vi.fn(),
}));
vi.mock("../printRouter", () => ({ resolveBridgeApiKey: (key: string | null) => key || "central" }));
vi.mock("../print/printRouting", () => ({ validatePrinterForDocument: vi.fn() }));

import { loadPrintAdminActor, printerPaper, retirePrinter, scopeBridgeToLocation, verifyBridgeQueue, PrintAdminError } from "../print/printerAdmin";

describe("printer admin operator path", () => {
  beforeEach(() => {
    rows.users = [
      { id: 1, role: "global_admin", tenantId: 1, isActive: true, email: "g@example.test" },
      { id: 2, role: "admin", tenantId: 2, isActive: true, email: "a@example.test" },
      { id: 3, role: "staff", tenantId: 1, isActive: true, email: "s@example.test" },
      { id: 4, role: "admin", tenantId: 1, isActive: false, email: "x@example.test" },
    ];
    rows.bridges = [{ id: 2, tenantId: 1, isActive: true, locationId: null, routingScope: "general", name: "Raspberry Pi - Box 2", bridgeType: "generic", priority: 10, supportedRoles: "both", notes: null, networkSubnetHint: null, bridgeUrl: "http://box-2.test:3100", apiKey: "pi-key-0123456789abcdef0123456789abcdef" }];
    rows.locations = [{ id: 4, tenantId: 1, isActive: true, name: "CSR Sales Box 2" }];
    rows.printers = [{ id: 3, tenantId: 1, isActive: false, bridgeProfileId: 2, bridgePrinterName: "Beeprt_USB" }];
    rows.audits = [];
    vi.restoreAllMocks();
  });

  it("re-registers a general bridge at a location without exposing its key, and retires the general record", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const actor = { id: 1, email: "g@example.test", role: "global_admin" };
    rows.printers.push({ id: 5, tenantId: 1, bridgeProfileId: 2, isActive: true });
    await expect(scopeBridgeToLocation(1, actor, 2, 4)).rejects.toThrow(/still has active printer 5/);
    rows.printers.pop();

    const result = await scopeBridgeToLocation(1, actor, 2, 4, "test");
    expect(result).toMatchObject({ reused: false, retiredBridgeId: 2, keyFingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) });
    const created = rows.bridges.find((row) => row.id === result.bridgeId)!;
    expect(created).toMatchObject({ tenantId: 1, locationId: 4, routingScope: "location", bridgeUrl: "http://box-2.test:3100", apiKey: "pi-key-0123456789abcdef0123456789abcdef", isActive: true });
    expect(rows.bridges[0]).toMatchObject({ id: 2, isActive: false, name: "Raspberry Pi - Box 2 (retired general)" });
    expect(rows.audits.map((entry) => entry.action)).toEqual(["PRINT_BRIDGE_CREATED", "PRINT_BRIDGE_RETIRED"]);
    expect(JSON.stringify(rows.audits)).not.toContain("pi-key-");

    await expect(scopeBridgeToLocation(1, actor, 2, 4)).resolves.toMatchObject({ bridgeId: result.bridgeId, reused: true });
    expect(rows.bridges.filter((row) => row.locationId === 4)).toHaveLength(1);
    await expect(scopeBridgeToLocation(1, actor, 2, 9)).rejects.toThrow(/location not found/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retires an old record: inactive, queue renamed as metadata, audited, idempotent, no bridge contact", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const actor = { id: 1, email: "g@example.test", role: "global_admin" };
    const retired = await retirePrinter(1, actor, 3, "test");
    expect(retired).toMatchObject({ id: 3, isActive: false, bridgePrinterName: "retired-3-Beeprt_USB" });
    expect(rows.audits).toEqual([expect.objectContaining({
      action: "PRINT_PRINTER_RETIRED", resourceId: "3",
      metadata: expect.objectContaining({ previousQueue: "Beeprt_USB", retiredQueue: "retired-3-Beeprt_USB" }),
    })]);
    await retirePrinter(1, actor, 3, "test");
    expect(rows.audits).toHaveLength(1);
    expect(rows.printers[0]!.bridgePrinterName).toBe("retired-3-Beeprt_USB");
    await expect(retirePrinter(2, actor, 3)).rejects.toThrow(/not found/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts only an active admin of the tenant or a global admin", async () => {
    await expect(loadPrintAdminActor(1, 1)).resolves.toMatchObject({ id: 1 });
    for (const actorId of [2, 3, 4, 99]) await expect(loadPrintAdminActor(1, actorId)).rejects.toBeInstanceOf(PrintAdminError);
  });

  it("requires the queue to be on the bridge's own allowlist, using the bridge's key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ printerNames: ["Beeprt_USB"] }), { status: 200 }));
    await expect(verifyBridgeQueue(1, 2, "Beeprt_USB")).resolves.toEqual({ bridgeUrl: "http://box-2.test:3100", queues: ["Beeprt_USB"] });
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://box-2.test:3100/printers");
    expect((fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>)["x-api-key"]).toBe("pi-key-0123456789abcdef0123456789abcdef");
    await expect(verifyBridgeQueue(1, 2, "Brother_HL_L2405W")).rejects.toThrow(/not served by this bridge/);
  });

  it("fails closed for a rejected key, another tenant's bridge, or an unreachable bridge", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 401 }));
    await expect(verifyBridgeQueue(1, 2, "Beeprt_USB")).rejects.toThrow(/rejected/);
    await expect(verifyBridgeQueue(2, 2, "Beeprt_USB")).rejects.toThrow(/not found in this tenant/);
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("fetch failed"));
    await expect(verifyBridgeQueue(1, 2, "Beeprt_USB")).rejects.toThrow(/unreachable/);
  });

  it("thermal printers are 50mm or 80mm only; 58mm is rejected", () => {
    expect(printerPaper("thermal", "50mm")).toEqual({ printerClass: "thermal", paperWidth: "50mm" });
    expect(printerPaper("thermal", "58mm")).toEqual({ error: "Thermal paperWidth must be 50mm or 80mm" });
    expect(printerPaper("full_page", undefined)).toEqual({ printerClass: "full_page", paperWidth: "letter" });
  });
});
