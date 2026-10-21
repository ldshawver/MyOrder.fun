import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  product: { id: 1, tenantId: 1, isAvailable: true, metadata: {} } as Record<string, unknown>,
  hasAttempt: true, lock: vi.fn(), update: vi.fn(), insert: vi.fn(),
}));
vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  const order = { id: 10, tenantId: 1, customerId: 2, status: "pending", paymentStatus: "unpaid", total: "10.00", subtotal: "10.00", remainingTenderAmount: "10.00", financialFinalizedAt: new Date(), customerCreditApplied: "0.00", checkoutConversionSnapshot: {}, legalDisclaimerAccepted: true, finalConfirmationAt: new Date() };
  const attempt = { id: 20, state: "created", providerEnvironment: "sandbox", providerOrderId: "provider-20", requestedAmount: "10.00", requestedCurrency: "USD" };
  const tx = {
    execute: vi.fn(),
    transaction: async (fn: (executor: typeof tx) => unknown): Promise<unknown> => fn(tx),
    select: () => ({ from: (table: unknown) => {
      const rows = table === original.ordersTable ? [order]
        : table === original.orderItemsTable ? [{ catalogItemId: 1 }]
        : table === original.catalogItemsTable ? [state.product]
        : table === original.paymentAttemptsTable && state.hasAttempt ? [attempt] : [];
      const chain = Object.assign(Promise.resolve(rows), {
        where: () => chain, limit: () => chain, orderBy: () => chain,
        for: (mode: string) => { state.lock(mode); return chain; },
      });
      return chain;
    } }),
    update: (...args: unknown[]) => { state.update(...args); return { set: () => ({ where: async () => [] }) }; },
    insert: (...args: unknown[]) => { state.insert(...args); return { values: () => ({ onConflictDoNothing: async () => [] }) }; },
  };
  return { ...original, db: { ...tx, transaction: async (fn: (executor: typeof tx) => unknown) => fn(tx) } };
});
vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => { req.dbUser = { id: 2, tenantId: 1, role: "customer" }; next(); },
  requireDbUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApproved: (_req: unknown, _res: unknown, next: () => void) => next(),
  writeAuditLog: vi.fn(),
}));
vi.mock("../../lib/customerDisclaimerEnforcement", () => ({ requireCurrentCustomerDisclaimerAcceptance: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../inventory", () => ({ deductPaidOrderInventory: vi.fn() }));
vi.mock("../customerCredit", () => ({
  reserveCustomerCredit: vi.fn(async () => ({ appliedCents: 1000, account: { balance: "10.00", reservedBalance: "10.00" } })),
  consumeCustomerCredit: vi.fn(async () => ({ account: { balance: "0.00" } })),
  restoreCustomerCredit: vi.fn(), CustomerCreditError: class extends Error {},
}));

import { PaymentService } from "../service";
import type { EnabledPaymentConfig, PaymentProvider } from "../provider";
import { reserveCustomerCredit, consumeCustomerCredit } from "../customerCredit";
import { requireOrderCatalogForSale } from "../../lib/orderCatalogEligibility";
import { db } from "@workspace/db";
import paymentsRouter from "../../routes/payments";

const app = express();
app.use(express.json());
app.use("/api", paymentsRouter);
const provider = { createOrder: vi.fn(), captureOrder: vi.fn(async () => ({ orderId: "provider-20", captureId: "capture-20", status: "COMPLETED", amount: { value: "10.00", currency: "USD" } })) };
const service = new PaymentService({ environment: "sandbox" } as EnabledPaymentConfig, provider as unknown as PaymentProvider);
const input = { tenantId: 1, customerId: 2, orderId: 10, idempotencyKey: "eligibility-test" };

beforeEach(() => {
  vi.clearAllMocks();
  state.hasAttempt = true;
  state.product = { id: 1, tenantId: 1, isAvailable: true, metadata: {} };
});

describe.each([
  ["archived", { metadata: { archived: true } }],
  ["compliance hold", { metadata: { complianceHold: true } }],
  ["not for sale", { isAvailable: false }],
])("existing unpaid order with %s product", (_name, patch) => {
  it("blocks payment creation and capture before any provider call or payment mutation", async () => {
    Object.assign(state.product, patch);
    const finalize = vi.fn();
    await expect(service.create(input)).rejects.toMatchObject({ code: "CATALOG_ITEM_UNAVAILABLE", statusCode: 409 });
    await expect(service.capture({ ...input, attemptId: 20, finalize })).rejects.toMatchObject({ code: "CATALOG_ITEM_UNAVAILABLE", statusCode: 409 });
    expect(provider.createOrder).not.toHaveBeenCalled();
    expect(provider.captureOrder).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(state.insert).not.toHaveBeenCalled();
  });

  it("blocks customer credit payment before reserving or consuming credit", async () => {
    Object.assign(state.product, patch);
    state.hasAttempt = false;
    const response = await supertest(app).post("/api/payments/10/apply-credit").set("Idempotency-Key", "eligibility-test").send({ amount: 10 });
    expect(response.status, response.text).toBe(409);
    expect(response.body.error).toBe("CATALOG_ITEM_UNAVAILABLE");
    expect(reserveCustomerCredit).not.toHaveBeenCalled();
    expect(consumeCustomerCredit).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });
});

it("keeps active products payable and locks their catalog rows through capture", async () => {
  await expect(service.create(input)).resolves.toMatchObject({ providerOrderId: "provider-20" });
  const finalize = vi.fn();
  await expect(service.capture({ ...input, attemptId: 20, finalize })).resolves.toMatchObject({ status: "captured" });
  expect(state.lock).toHaveBeenCalledWith("update");
  expect(provider.captureOrder).toHaveBeenCalledOnce();
  expect(finalize).toHaveBeenCalledOnce();
});

it("keeps active products payable with customer credit", async () => {
  state.hasAttempt = false;
    const response = await supertest(app).post("/api/payments/10/apply-credit").set("Idempotency-Key", "eligibility-test").send({ amount: 10 });
  expect(response.status, response.text).toBe(200);
  expect(response.body.paymentStatus).toBe("paid");
  expect(consumeCustomerCredit).toHaveBeenCalledOnce();
});

it("accepts active legacy products without lifecycle metadata", async () => {
  state.product.metadata = null;
  await expect(requireOrderCatalogForSale(db, { id: 10, tenantId: 1 })).resolves.toBeUndefined();
});
