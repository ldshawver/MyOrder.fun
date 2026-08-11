import { beforeEach, describe, expect, it, vi } from "vitest";

const selectResults: unknown[][] = [];
const makeSelectChain = () => {
  const result = selectResults.shift() ?? [];
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
};

vi.mock("@workspace/db", () => ({
  db: { select: vi.fn(() => makeSelectChain()) },
  labTechShiftsTable: { status: "status", clockedInAt: "clockedInAt", techId: "techId", tenantId: "tenantId", id: "shiftId" },
  shiftPrintAssignmentsTable: { tenantId: "tenantId", shiftId: "shiftId", locationId: "locationId", receiptPrinterId: "receiptPrinterId", expoPrinterId: "expoPrinterId", printExpoTickets: "printExpoTickets" },
  usersTable: { id: "id", isActive: "isActive", role: "role", tenantId: "tenantId" },
  operatorPrintProfilesTable: { userId: "userId", tenantId: "tenantId", locationId: "locationId", shiftId: "shiftId" },
  printPrintersTable: { id: "id", tenantId: "tenantId", locationId: "locationId", routingScope: "routingScope", isActive: "isActive", role: "role" },
}));

vi.mock("../logger", () => ({ logger: { child: () => ({}) } }));

import { resolveBridgeApiKey, resolveReceiptPrinters } from "../printRouter";

describe("printRouter", () => {
  beforeEach(() => {
    selectResults.length = 0;
    delete process.env.PRINT_BRIDGE_API_KEY;
  });

  it("selects the receipt printer explicitly assigned to the operator profile", async () => {
    const assigned = { id: 41, name: "Box_1_Receipt", role: "receipt", isActive: true };
    selectResults.push([{ tenantId: 1, shiftId: 7, locationId: 1, receiptPrinterId: 41 }], [assigned]);

    const result = await resolveReceiptPrinters({
      id: 9,
      tenantId: 1,
      userId: 22,
      locationId: 1,
      shiftId: 7,
      receiptPrinterId: 41,
      labelPrinterId: null,
      expoPrinterId: null,
      printExpoTickets: false,
      fallbackReceiptPrinterId: null,
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, { tenantId: 1, locationId: 1, shiftId: 7 });

    expect(result.primary).toEqual(assigned);
    expect(result.fallback).toBeNull();
  });

  it("fails closed when no operator printer profile exists", async () => {
    const result = await resolveReceiptPrinters(null, { tenantId: 1, locationId: 2, shiftId: 9 });
    expect(result).toEqual({ primary: null, fallback: null });
  });

  it("uses the central credential when a bridge profile credential is empty", () => {
    process.env.PRINT_BRIDGE_API_KEY = "central-secret";
    expect(resolveBridgeApiKey("")).toBe("central-secret");
    expect(resolveBridgeApiKey(null)).toBe("central-secret");
    expect(resolveBridgeApiKey("profile-secret")).toBe("profile-secret");
  });
});
