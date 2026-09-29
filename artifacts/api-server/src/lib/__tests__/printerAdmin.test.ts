/**
 * Operator path for printer registration: admin authorization, the bridge's
 * own queue allowlist, and the paper rules shared with the admin routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ users: [] as Array<Record<string, unknown>>, bridges: [] as Array<Record<string, unknown>> }));

vi.mock("@workspace/db", () => {
  const select = vi.fn(() => ({
    from: (table: { name: string }) => ({
      where: (predicates: Array<{ column: string; value: unknown }> | { column: string; value: unknown }) => ({
        limit: async () => {
          const list = Array.isArray(predicates) ? predicates : [predicates];
          const source = table.name === "users" ? rows.users : rows.bridges;
          return source.filter((row) => list.every(({ column, value }) => row[column] === value));
        },
      }),
    }),
  }));
  return {
    db: { select },
    usersTable: { name: "users", id: "id" },
    printBridgeProfilesTable: { name: "bridges", id: "id", tenantId: "tenantId", isActive: "isActive" },
    printPrintersTable: {}, printRoutesTable: {}, inventoryLocationsTable: {}, auditLogsTable: {},
  };
});
vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown) => ({ column, value }),
  and: (...predicates: unknown[]) => predicates,
  isNull: vi.fn(),
}));
vi.mock("../printRouter", () => ({ resolveBridgeApiKey: (key: string | null) => key || "central" }));
vi.mock("../print/printRouting", () => ({ validatePrinterForDocument: vi.fn() }));

import { loadPrintAdminActor, printerPaper, verifyBridgeQueue, PrintAdminError } from "../print/printerAdmin";

describe("printer admin operator path", () => {
  beforeEach(() => {
    rows.users = [
      { id: 1, role: "global_admin", tenantId: 1, isActive: true, email: "g@example.test" },
      { id: 2, role: "admin", tenantId: 2, isActive: true, email: "a@example.test" },
      { id: 3, role: "staff", tenantId: 1, isActive: true, email: "s@example.test" },
      { id: 4, role: "admin", tenantId: 1, isActive: false, email: "x@example.test" },
    ];
    rows.bridges = [{ id: 2, tenantId: 1, isActive: true, bridgeUrl: "http://box-2.test:3100", apiKey: "pi-key-0123456789abcdef0123456789abcdef" }];
    vi.restoreAllMocks();
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
