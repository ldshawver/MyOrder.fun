import { beforeEach, describe, expect, it, vi } from "vitest";
import { PayPalProviderError } from "../paypal";

const state = vi.hoisted(() => ({
  attempts: [] as Array<Record<string, unknown>>,
  captures: [] as Array<Record<string, unknown>>,
  reserved: vi.fn(),
  released: vi.fn(),
}));

vi.mock("../inventory", () => ({ ensurePaidOrderInventoryReserved: state.reserved,
  PaymentInventoryError: class PaymentInventoryError extends Error {} }));
vi.mock("../../lib/inventoryReservations", () => ({ releaseInventoryReservationsForOrder: state.released }));
vi.mock("../customerCredit", () => ({ consumeCustomerCredit: vi.fn(), restoreCustomerCredit: vi.fn() }));
vi.mock("drizzle-orm", () => ({
  eq: (field: string, value: unknown) => ({ kind: "eq", field, value }),
  inArray: (field: string, values: unknown[]) => ({ kind: "in", field, values }),
  and: (...conditions: unknown[]) => ({ kind: "and", conditions }),
  sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({ parts, values }),
}));
vi.mock("@workspace/db", () => {
  const col = (name: string) => name;
  const ordersTable = { table: "orders", id: col("id"), tenantId: col("tenantId") };
  const paymentAttemptsTable = { table: "attempts", id: col("id"), tenantId: col("tenantId"), orderId: col("orderId"), idempotencyKey: col("idempotencyKey"), state: col("state") };
  const paymentCapturesTable = { table: "captures", id: col("id"), paymentAttemptId: col("paymentAttemptId") };
  const other = { id: col("id"), tenantId: col("tenantId"), orderId: col("orderId") };
  const order = { id: 4, tenantId: 2, customerId: 9, paymentStatus: "unpaid", status: "submitted", checkoutConversionSnapshot: {}, legalDisclaimerAccepted: true, finalConfirmationAt: new Date(), remainingTenderAmount: "12.00", total: "12.00" };
  function matches(row: Record<string, unknown>, condition: unknown): boolean {
    const c = condition as { kind?: string; field?: string; value?: unknown; values?: unknown[]; conditions?: unknown[] };
    if (c.kind === "eq") return row[c.field!] === c.value;
    if (c.kind === "in") return c.values!.includes(row[c.field!]);
    if (c.kind === "and") return c.conditions!.every(part => matches(row, part));
    return true;
  }
  const tx = {
    execute: vi.fn(async () => []),
    select: vi.fn(() => ({ from: (table: { table: string }) => ({ where: (condition: unknown) => {
      const limit = async () => (table.table === "orders" ? [order] : table.table === "captures" ? state.captures : state.attempts).filter(row => matches(row, condition)).slice(0, 1);
      return { limit, orderBy: () => ({ limit }) };
    } }) })),
    insert: vi.fn((table: { table?: string }) => ({ values: (values: Record<string, unknown>) => {
      const target = table.table === "captures" ? state.captures : state.attempts;
      const inserted = { id: target.length + 1, ...values };
      return {
        returning: async () => { target.push(inserted); return [inserted]; },
        onConflictDoNothing: async () => { target.push(inserted); return []; },
      };
    } })),
    update: vi.fn(() => ({ set: (values: Record<string, unknown>) => ({ where: async (condition: unknown) => {
      for (const attempt of state.attempts) if (matches(attempt, condition)) Object.assign(attempt, values);
    } }) })),
    transaction: async (work: (value: typeof tx) => Promise<unknown>) => {
      const before = state.attempts.map(attempt => ({ ...attempt }));
      try { return await work(tx); } catch (error) { state.attempts = before; throw error; }
    },
  };
  return { db: { transaction: async (work: (value: typeof tx) => Promise<unknown>) => {
    const before = state.attempts.map(attempt => ({ ...attempt }));
    try { return await work(tx); } catch (error) { state.attempts = before; throw error; }
  } }, ordersTable, paymentAttemptsTable, orderTaxSnapshotsTable: other, paymentCapturesTable,
    paymentRefundsTable: other, paymentWebhookEventsTable: other };
});

const { PaymentService } = await import("../service");
const input = { tenantId: 2, customerId: 9, orderId: 4, idempotencyKey: "first" };
const config = { enabled: true, environment: "sandbox" } as never;

beforeEach(() => { state.attempts = []; state.captures = []; state.reserved.mockReset(); state.released.mockReset(); });

describe("payment attempt and inventory lifecycle", () => {
  it("commits an unknown provider outcome and keeps inventory held", async () => {
    const service = new PaymentService(config, { createOrder: vi.fn(async () => { throw new PayPalProviderError("unknown_outcome", "timeout after send"); }) } as never);
    await expect(service.create(input)).rejects.toThrow("timeout after send");
    expect(state.attempts[0]).toMatchObject({ state: "reconciliation_required", reconciliationState: "pending" });
    expect(state.reserved).toHaveBeenCalledTimes(1);
    expect(state.released).not.toHaveBeenCalled();
    await expect(service.create({ ...input, idempotencyKey: "retry" })).rejects.toMatchObject({ code: "PAYMENT_RECONCILIATION_REQUIRED" });
  });

  it("releases after definitive failure and allows a new keyed retry", async () => {
    const provider = { createOrder: vi.fn()
      .mockRejectedValueOnce(new PayPalProviderError("declined", "declined"))
      .mockResolvedValueOnce({ id: "P-1", amount: { value: "12.00", currency: "USD" }, approvalUrl: "https://example.test" }) };
    const service = new PaymentService(config, provider as never);
    await expect(service.create(input)).rejects.toThrow("declined");
    expect(state.attempts[0]).toMatchObject({ state: "failed" });
    expect(state.released).toHaveBeenCalledTimes(1);
    await expect(service.create(input)).rejects.toMatchObject({ code: "PAYMENT_ATTEMPT_FAILED" });
    const retried = await service.create({ ...input, idempotencyKey: "second" });
    expect(retried.providerOrderId).toBe("P-1");
    expect(state.reserved).toHaveBeenCalledTimes(2);
  });

  it("keeps inventory held after an unknown capture result", async () => {
    state.attempts.push({ id: 1, tenantId: 2, orderId: 4, idempotencyKey: "first", providerOrderId: "P-1",
      state: "created", requestedAmount: "12.00", requestedCurrency: "USD" });
    const provider = { captureOrder: vi.fn(async () => { throw new PayPalProviderError("unknown_outcome", "capture timed out"); }) };
    const finalize = vi.fn();
    const service = new PaymentService(config, provider as never);
    await expect(service.capture({ ...input, attemptId: 1, finalize })).rejects.toThrow("capture timed out");
    expect(state.attempts[0]).toMatchObject({ state: "reconciliation_required", reconciliationState: "pending" });
    expect(state.released).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("releases only on a definitive capture decline", async () => {
    state.attempts.push({ id: 1, tenantId: 2, orderId: 4, idempotencyKey: "first", providerOrderId: "P-1",
      state: "created", requestedAmount: "12.00", requestedCurrency: "USD" });
    const provider = { captureOrder: vi.fn(async () => { throw new PayPalProviderError("declined", "declined"); }) };
    const service = new PaymentService(config, provider as never);
    await expect(service.capture({ ...input, attemptId: 1, finalize: vi.fn() })).rejects.toThrow("declined");
    expect(state.attempts[0]).toMatchObject({ state: "failed" });
    expect(state.released).toHaveBeenCalledTimes(1);
  });

  it("keeps a captured provider payment in reconciliation when local finalization fails", async () => {
    state.attempts.push({ id: 1, tenantId: 2, orderId: 4, idempotencyKey: "first", providerOrderId: "P-1",
      state: "created", requestedAmount: "12.00", requestedCurrency: "USD" });
    const provider = { captureOrder: vi.fn(async () => ({ orderId: "P-1", captureId: "C-1", status: "COMPLETED",
      amount: { value: "12.00", currency: "USD" }, fundingSource: "paypal" })) };
    const finalize = vi.fn(async () => { throw new Error("local inventory write failed"); });
    const service = new PaymentService(config, provider as never);
    await expect(service.capture({ ...input, attemptId: 1, finalize })).rejects.toThrow("local inventory write failed");
    expect(state.attempts[0]).toMatchObject({ state: "reconciliation_required", failureClass: "local_finalize_failed" });
    expect(state.captures).toHaveLength(1);
    expect(state.released).not.toHaveBeenCalled();
    await expect(service.capture({ ...input, attemptId: 1, finalize })).rejects.toMatchObject({ code: "PAYMENT_RECONCILIATION_REQUIRED" });
    expect(provider.captureOrder).toHaveBeenCalledTimes(1);
  });
});
