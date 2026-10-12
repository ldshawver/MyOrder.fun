import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: "reserved",
  transaction: null as unknown,
  movement: vi.fn(async () => ({ postQuantity: "9.000000" })),
}));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => parts,
  eq: (field: unknown, value: unknown) => ({ field, value }),
  sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({ parts, values }),
}));
vi.mock("@workspace/db", () => {
  const columns = { id: "id", orderItemId: "orderItemId", catalogItemId: "catalogItemId", locationId: "locationId",
    quantity: "quantity", status: "status", expiresAt: "expiresAt", orderId: "orderId", tenantId: "tenantId", name: "name" };
  return { db: {}, inventoryLocationsTable: columns, inventoryMovementsTable: columns,
    inventoryReservationsTable: columns, ordersTable: columns };
});
vi.mock("../inventoryKernel", () => ({
  executeTransaction: async (_tenantId: number, _executor: unknown, _context: string,
    work: (transaction: unknown) => Promise<unknown>) => work(state.transaction),
}));
vi.mock("../inventoryMovementLedger", () => ({ postInventoryMovement: state.movement }));

const { confirmInventoryReservationsForOrder } = await import("../inventoryReservations");

beforeEach(() => {
  state.status = "reserved";
  state.movement.mockClear();
  const reservation = { id: 33, orderItemId: 34, productId: 183, locationId: 1,
    quantity: "1.000000", locationName: "Backstock" };
  state.transaction = {
    execute: async () => [{ id: 29 }],
    select: (projection: Record<string, unknown>) => ({
      from: () => ({
        innerJoin: () => ({ where: async () => state.status === "reserved" ? [reservation] : [] }),
        where: () => ({ limit: async () => projection.tenantId ? [{ tenantId: 1 }] : [reservation] }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => { state.status = "confirmed"; } }) }),
  };
});

describe("paid order inventory movement attribution", () => {
  it("records the order line from its reservation and does not post twice on confirmation replay", async () => {
    const actor = { id: 7, email: "actor@example.test", role: "admin" };
    const first = await confirmInventoryReservationsForOrder(state.transaction as never, 1, 29, actor);
    expect(first).toMatchObject([{ productId: 183, orderItemId: 34, locationId: 1 }]);
    expect(state.movement).toHaveBeenCalledWith(state.transaction, expect.objectContaining({
      tenantId: 1, orderId: 29, orderItemId: 34, itemId: 183, locationId: 1,
      quantity: "1.000000", idempotencyKey: "sale:29:33",
    }));

    await confirmInventoryReservationsForOrder(state.transaction as never, 1, 29, actor);
    expect(state.movement).toHaveBeenCalledTimes(1);
  });
});
