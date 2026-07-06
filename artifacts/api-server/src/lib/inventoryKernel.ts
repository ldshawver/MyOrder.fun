import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { assertCatalogIdInventoryLookup } from "./inventoryIdentityGuard";
import { logger } from "./logger";

type KernelTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type KernelExecutor = typeof db | KernelTransaction;

type NegativeBalanceViolation = { productId: number; locationId: number; quantityOnHand: unknown };
type ReservationOverageViolation = { productId: number; locationId: number; quantityOnHand: unknown; activeReserved: unknown };
type ReservationIdentityViolation = { reservationId: number; orderId: number | null; catalogItemId: number | null; idempotencyKey: string | null; reason: string };
type InventoryFailureClassification = "INSUFFICIENT_STOCK" | "RESERVATION_CONFLICT" | "IDENTITY_MISMATCH" | "RACE_CONDITION_DETECTED";
type InventorySnapshot = { balances: unknown[]; reservations: unknown[] };
type InventoryTransactionType = "reserve" | "confirm" | "deduct" | "release" | "import" | "bootstrap" | "repair" | "unknown";

export type InventoryKernelTransaction = KernelTransaction;
export type InventoryKernelExecutor = KernelExecutor;

export class InventoryInvariantViolationError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly report: Awaited<ReturnType<typeof collectInventoryInvariantReport>>,
    readonly trace: { context: string; phase: string },
    readonly classification: InventoryFailureClassification,
  ) {
    super(message);
    this.name = "InventoryInvariantViolationError";
  }
}

function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

export async function ensureInventoryTransactionLogTable(executor: KernelExecutor): Promise<void> {
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS "inventory_transaction_log" (
      "id" serial PRIMARY KEY,
      "transaction_id" text NOT NULL,
      "type" text NOT NULL,
      "catalog_item_id" integer REFERENCES "catalog_items"("id"),
      "location_id" integer REFERENCES "inventory_locations"("id"),
      "quantity_change" numeric(10, 3) NOT NULL DEFAULT 0,
      "before_state" jsonb NOT NULL,
      "after_state" jsonb NOT NULL,
      "order_id" integer REFERENCES "orders"("id"),
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await executor.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "inventory_transaction_log_transaction_id_idx" ON "inventory_transaction_log" ("transaction_id")`);
  await executor.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_transaction_log_order_idx" ON "inventory_transaction_log" ("order_id")`);
  await executor.execute(sql`CREATE INDEX IF NOT EXISTS "inventory_transaction_log_catalog_location_idx" ON "inventory_transaction_log" ("catalog_item_id", "location_id")`);
}

async function collectInventorySnapshot(executor: KernelExecutor): Promise<InventorySnapshot> {
  const balances = rowsFrom(await executor.execute(sql`
    SELECT product_id AS "productId", location_id AS "locationId", quantity_on_hand AS "quantityOnHand", par_level AS "parLevel"
    FROM inventory_balances
    ORDER BY product_id, location_id
  `));
  const reservations = rowsFrom(await executor.execute(sql`
    SELECT id, order_id AS "orderId", catalog_item_id AS "catalogItemId", location_id AS "locationId", quantity, status, idempotency_key AS "idempotencyKey", expires_at AS "expiresAt"
    FROM inventory_reservations
    ORDER BY id
  `));
  return { balances, reservations };
}

function classifyInvariantFailure(report: Awaited<ReturnType<typeof collectInventoryInvariantReport>>): InventoryFailureClassification {
  if (report.reservationIdentityViolations.length > 0) return "IDENTITY_MISMATCH";
  if (report.reservationOverages.length > 0) return "RESERVATION_CONFLICT";
  if (report.negativeBalances.length > 0) return "RACE_CONDITION_DETECTED";
  return "INSUFFICIENT_STOCK";
}

function transactionTypeFromContext(context: string): InventoryTransactionType {
  const lowered = context.toLowerCase();
  if (lowered.includes("reserve")) return "reserve";
  if (lowered.includes("confirm")) return "confirm";
  if (lowered.includes("deduct")) return "deduct";
  if (lowered.includes("release")) return "release";
  if (lowered.includes("import")) return "import";
  if (lowered.includes("bootstrap")) return "bootstrap";
  if (lowered.includes("repair") || lowered.includes("reconcile")) return "repair";
  return "unknown";
}

function transactionIdForContext(context: string): string {
  return `${context}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function snapshotQuantityTotal(snapshot: InventorySnapshot): number {
  return snapshot.balances.reduce<number>((sum, row) => sum + Number((row as { quantityOnHand?: unknown }).quantityOnHand ?? 0), 0);
}

async function writeInventoryTransactionLog(executor: KernelExecutor, params: { context: string; beforeState: InventorySnapshot; afterState: InventorySnapshot }): Promise<string> {
  const transactionId = transactionIdForContext(params.context);
  const quantityChange = snapshotQuantityTotal(params.afterState) - snapshotQuantityTotal(params.beforeState);
  await executor.execute(sql`
    INSERT INTO inventory_transaction_log (transaction_id, type, quantity_change, before_state, after_state, created_at)
    VALUES (${transactionId}, ${transactionTypeFromContext(params.context)}, ${String(quantityChange)}, ${JSON.stringify(params.beforeState)}::jsonb, ${JSON.stringify(params.afterState)}::jsonb, now())
  `);
  return transactionId;
}

export async function collectInventoryInvariantReport(executor: KernelExecutor): Promise<{
  negativeBalances: NegativeBalanceViolation[];
  reservationOverages: ReservationOverageViolation[];
  reservationIdentityViolations: ReservationIdentityViolation[];
}> {
  const negativeBalances = rowsFrom<NegativeBalanceViolation>(await executor.execute(sql`
    SELECT product_id AS "productId", location_id AS "locationId", quantity_on_hand AS "quantityOnHand"
    FROM inventory_balances
    WHERE quantity_on_hand < 0
  `));

  const reservationOverages = rowsFrom<ReservationOverageViolation>(await executor.execute(sql`
    SELECT ib.product_id AS "productId", ib.location_id AS "locationId", ib.quantity_on_hand AS "quantityOnHand",
      COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'reserved' AND r.expires_at > now()), 0) AS "activeReserved"
    FROM inventory_balances ib
    LEFT JOIN inventory_reservations r ON r.catalog_item_id = ib.product_id AND r.location_id = ib.location_id
    GROUP BY ib.product_id, ib.location_id, ib.quantity_on_hand
    HAVING ib.quantity_on_hand < COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'reserved' AND r.expires_at > now()), 0)
  `));

  const reservationIdentityViolations = rowsFrom<ReservationIdentityViolation>(await executor.execute(sql`
    SELECT r.id AS "reservationId", r.order_id AS "orderId", r.catalog_item_id AS "catalogItemId", r.idempotency_key AS "idempotencyKey",
      CASE
        WHEN r.catalog_item_id IS NULL THEN 'missing_catalog_item_id'
        WHEN r.idempotency_key IS NULL OR btrim(r.idempotency_key) = '' THEN 'missing_idempotency_key'
        WHEN ci.id IS NULL THEN 'missing_catalog_item'
        ELSE 'unknown'
      END AS "reason"
    FROM inventory_reservations r
    LEFT JOIN catalog_items ci ON ci.id = r.catalog_item_id
    WHERE r.catalog_item_id IS NULL
      OR r.idempotency_key IS NULL
      OR btrim(r.idempotency_key) = ''
      OR ci.id IS NULL
  `));

  return { negativeBalances, reservationOverages, reservationIdentityViolations };
}

export async function assertInventoryInvariants(executor: KernelExecutor, trace: { context: string; phase: string }): Promise<void> {
  const report = await collectInventoryInvariantReport(executor);
  const violationCount = report.negativeBalances.length + report.reservationOverages.length + report.reservationIdentityViolations.length;
  if (violationCount === 0) return;
  logger.error({ trace, report }, "INVENTORY INVARIANT VIOLATION — transaction rejected");
  throw new InventoryInvariantViolationError("INVENTORY INVARIANT VIOLATION — transaction rejected", report, trace, classifyInvariantFailure(report));
}

async function runKernelWork<T>(tx: KernelTransaction, context: string, work: (tx: KernelTransaction) => Promise<T>): Promise<T> {
  logger.debug?.({ context }, "inventory kernel transaction started");
  await ensureInventoryTransactionLogTable(tx);
  const beforeState = await collectInventorySnapshot(tx);
  const result = await work(tx);
  const afterState = await collectInventorySnapshot(tx);
  await assertInventoryInvariants(tx, { context, phase: "before_commit" });
  const transactionId = await writeInventoryTransactionLog(tx, { context, beforeState, afterState });
  logger.debug?.({ context, transactionId }, "inventory kernel transaction journaled");
  return result;
}

export async function replayInventoryTransaction(transactionId: string): Promise<{
  transactionId: string;
  transaction: unknown;
  lifecycleTrace: unknown[];
  reservationChain: unknown[];
  deductionChain: unknown[];
  finalState: InventorySnapshot;
  invariantReport: Awaited<ReturnType<typeof collectInventoryInvariantReport>>;
  diverged: boolean;
}> {
  await ensureInventoryTransactionLogTable(db);
  const transaction = rowsFrom<{ beforeState: InventorySnapshot; afterState: InventorySnapshot; orderId?: number | null; catalogItemId?: number | null; locationId?: number | null }>(await db.execute(sql`
    SELECT id, transaction_id AS "transactionId", type, catalog_item_id AS "catalogItemId", location_id AS "locationId", quantity_change AS "quantityChange", before_state AS "beforeState", after_state AS "afterState", order_id AS "orderId", created_at AS "createdAt"
    FROM inventory_transaction_log
    WHERE transaction_id = ${transactionId}
    LIMIT 1
  `))[0];
  if (!transaction) throw new Error(`Inventory transaction ${transactionId} was not found`);
  const finalState = await collectInventorySnapshot(db);
  const invariantReport = await collectInventoryInvariantReport(db);
  const reservationChain = rowsFrom(await db.execute(sql`
    SELECT * FROM inventory_reservations
    WHERE (${transaction.orderId ?? null}::integer IS NOT NULL AND order_id = ${transaction.orderId ?? null})
       OR (${transaction.catalogItemId ?? null}::integer IS NOT NULL AND catalog_item_id = ${transaction.catalogItemId ?? null})
    ORDER BY id
  `));
  const deductionChain = rowsFrom(await db.execute(sql`
    SELECT id, order_id AS "orderId", catalog_item_id AS "catalogItemId", inventory_deductions AS "inventoryDeductions"
    FROM order_items
    WHERE (${transaction.orderId ?? null}::integer IS NOT NULL AND order_id = ${transaction.orderId ?? null})
       OR (${transaction.catalogItemId ?? null}::integer IS NOT NULL AND catalog_item_id = ${transaction.catalogItemId ?? null})
    ORDER BY id
  `));
  return {
    transactionId,
    transaction,
    lifecycleTrace: [transaction],
    reservationChain,
    deductionChain,
    finalState,
    invariantReport,
    diverged: JSON.stringify(transaction.afterState) !== JSON.stringify(finalState),
  };
}

export async function executeTransaction<T>(
  contextOrExecutor: string | KernelExecutor,
  workOrContext: ((tx: KernelTransaction) => Promise<T>) | string,
  maybeWork?: (tx: KernelTransaction) => Promise<T>,
): Promise<T> {
  if (typeof contextOrExecutor === "string") {
    const context = contextOrExecutor;
    const work = workOrContext as (tx: KernelTransaction) => Promise<T>;
    return db.transaction(tx => runKernelWork(tx, context, work));
  }

  const executor = contextOrExecutor;
  const context = workOrContext as string;
  const work = maybeWork;
  if (!work) throw new Error("inventoryKernel.executeTransaction requires a work callback");
  if (executor === db) return db.transaction(tx => runKernelWork(tx, context, work));
  logger.debug?.({ context }, "inventory kernel reused caller transaction");
  return runKernelWork(executor as KernelTransaction, context, work);
}

export function assertKernelCatalogItemId(catalogItemId: number, context: string): void {
  assertCatalogIdInventoryLookup(catalogItemId, `inventoryKernel.${context}`);
}

export function reservationIdempotencyKey(params: { orderId: number; catalogItemId: number; locationId: number; orderType?: string }): string {
  return [params.orderId, params.catalogItemId, params.locationId, params.orderType ?? "UNKNOWN"].join(":");
}
