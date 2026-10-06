import { beforeEach, describe, expect, it, vi } from "vitest";
import { PayPalProviderError } from "../paypal";

const state = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  attempts: [] as Array<Record<string, unknown>>,
  locks: 0,
}));

vi.mock("../inventory", () => ({ ensurePaidOrderInventoryReserved: vi.fn(), PaymentInventoryError: class extends Error {} }));
vi.mock("../../lib/inventoryReservations", () => ({ releaseInventoryReservationsForOrder: vi.fn() }));
vi.mock("../customerCredit", () => ({ consumeCustomerCredit: vi.fn(), restoreCustomerCredit: vi.fn() }));
vi.mock("../../lib/checkoutNormalizer", () => ({ getCheckoutTaxSettings: vi.fn() }));
vi.mock("drizzle-orm", () => ({
  eq: (field: string, value: unknown) => ({ kind: "eq", field, value }),
  inArray: (field: string, values: unknown[]) => ({ kind: "in", field, values }),
  and: (...conditions: unknown[]) => ({ kind: "and", conditions }),
  sql: (parts: TemplateStringsArray, ...values: unknown[]) => ({ parts, values }),
}));
vi.mock("@workspace/db", () => {
  const table = (name: string) => new Proxy({ table: name }, { get: (target, key) => key === "table" ? target.table : String(key) });
  const events = table("events"); const attempts = table("attempts");
  const rows = (name: string) => name === "events" ? state.events : state.attempts;
  const matches = (row: Record<string, unknown>, condition: unknown): boolean => {
    const c = condition as { kind?: string; field?: string; value?: unknown; values?: unknown[]; conditions?: unknown[] };
    if (c.kind === "eq") return row[c.field!] === c.value;
    if (c.kind === "in") return c.values!.includes(row[c.field!]);
    if (c.kind === "and") return c.conditions!.every(part => matches(row, part));
    return true;
  };
  const query = {
    execute: vi.fn(async () => { state.locks++; }),
    select: () => ({ from: (selected: { table: string }) => ({ where: (condition: unknown) => ({ limit: async () => rows(selected.table).filter(row => matches(row, condition)).slice(0, 1) }) }) }),
    update: (selected: { table: string }) => ({ set: (values: Record<string, unknown>) => ({ where: async (condition: unknown) => {
      for (const row of rows(selected.table)) if (matches(row, condition)) Object.assign(row, values);
    } }) }),
  };
  const db = {
    ...query,
    insert: () => ({ values: (values: Record<string, unknown>) => ({ onConflictDoNothing: () => ({ returning: async () => {
      if (state.events.some(row => row.providerEventId === values.providerEventId)) return [];
      const row = { id: state.events.length + 1, ...values }; state.events.push(row); return [row];
    } }) }) }),
    transaction: async (work: (tx: typeof query) => Promise<unknown>) => work(query),
  };
  return { db, paymentWebhookEventsTable: events, paymentAttemptsTable: attempts,
    ordersTable: table("orders"), orderTaxSnapshotsTable: table("taxSnapshots"), paymentCapturesTable: table("captures"), paymentRefundsTable: table("refunds") };
});

const { PaymentService } = await import("../service");
const headers = { transmissionId: "transmission", transmissionTime: "time", transmissionSignature: "signature", certificateUrl: "https://api-m.sandbox.paypal.com/cert", authAlgorithm: "SHA256withRSA" };
const event = { id: "WH-123", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "P-123" } };
const config = { enabled: true, environment: "sandbox" } as never;

beforeEach(() => { state.events = []; state.attempts = [{ id: 11, tenantId: 2, provider: "paypal", providerEnvironment: "sandbox", providerOrderId: "P-123", state: "created", requestedAmount: "1.09", requestedCurrency: "USD" }]; state.locks = 0; });

describe("PayPal signed webhook retries", () => {
  it("retries a verified event after provider lookup fails, then processes it once", async () => {
    const getOrder = vi.fn().mockRejectedValueOnce(new PayPalProviderError("provider_error", "not available"))
      .mockResolvedValue({ id: "P-123", status: "APPROVED", amount: { value: "1.09", currency: "USD" } });
    const service = new PaymentService(config, { verifyWebhook: vi.fn(async () => true), getOrder } as never);
    await expect(service.verifyAndRecordWebhook(headers, event)).rejects.toBeInstanceOf(PayPalProviderError);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ processingState: "reconciliation_required", failureClass: "provider_lookup_failed" });
    expect(state.attempts[0].state).toBe("created");

    await expect(service.verifyAndRecordWebhook(headers, event)).resolves.toMatchObject({ replayed: true, processed: true });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ processingState: "processed", paymentAttemptId: 11 });
    expect(state.attempts[0].state).toBe("approved");
    await expect(service.verifyAndRecordWebhook(headers, event)).resolves.toMatchObject({ replayed: true, processed: true });
    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(state.locks).toBe(3);
  });
});
