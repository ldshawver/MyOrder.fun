/**
 * printControls.ts — per-tenant automatic-print switches.
 *
 * Authoritative for automatic order, receipt and label printing. Every read
 * and write is keyed by a server-resolved tenant id. A tenant with no row has
 * everything OFF. Changes are field-specific and guarded by an expected
 * version, so a stale screen cannot silently re-enable a flag it never meant
 * to touch; "pause all" turns everything off atomically. Every change is
 * audited with the actor, the previous values and the new values.
 */
import { eq } from "drizzle-orm";
import { db, tenantPrintControlsTable, auditLogsTable } from "@workspace/db";

export const PRINT_CONTROL_FLAGS = ["autoPrintOrders", "autoPrintReceipts", "autoPrintLabels"] as const;
export type PrintControlFlag = (typeof PRINT_CONTROL_FLAGS)[number];
export type PrintControlValues = Record<PrintControlFlag, boolean>;

export interface PrintControls extends PrintControlValues {
  /** 0 when the tenant has no row yet (everything off). */
  readonly version: number;
  readonly updatedAt: Date | null;
}

export interface PrintControlActor {
  id: number;
  email: string | null;
  role: string;
}

const OFF: PrintControlValues = { autoPrintOrders: false, autoPrintReceipts: false, autoPrintLabels: false };

type Executor = Pick<typeof db, "select" | "insert">;

function toControls(row: typeof tenantPrintControlsTable.$inferSelect | undefined): PrintControls {
  if (!row) return { ...OFF, version: 0, updatedAt: null };
  return {
    autoPrintOrders: row.autoPrintOrders,
    autoPrintReceipts: row.autoPrintReceipts,
    autoPrintLabels: row.autoPrintLabels,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

const values = (controls: PrintControlValues): PrintControlValues => ({
  autoPrintOrders: controls.autoPrintOrders,
  autoPrintReceipts: controls.autoPrintReceipts,
  autoPrintLabels: controls.autoPrintLabels,
});

async function readRow(executor: Executor, tenantId: number, lock: boolean) {
  const query = executor.select().from(tenantPrintControlsTable)
    .where(eq(tenantPrintControlsTable.tenantId, tenantId)).limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row;
}

/** The tenant's controls; all OFF when no row exists. */
export async function getPrintControls(tenantId: number): Promise<PrintControls> {
  return toControls(await readRow(db, tenantId, false));
}

async function writeControls(
  tx: Executor,
  tenantId: number,
  actor: PrintControlActor,
  previous: PrintControls,
  next: PrintControlValues,
  action: "PRINT_CONTROLS_UPDATED" | "PRINT_CONTROLS_PAUSED_ALL",
): Promise<PrintControls> {
  const version = previous.version + 1;
  const [row] = await tx.insert(tenantPrintControlsTable)
    .values({ tenantId, ...next, version, updatedAt: new Date(), updatedByUserId: actor.id })
    .onConflictDoUpdate({
      target: tenantPrintControlsTable.tenantId,
      set: { ...next, version, updatedAt: new Date(), updatedByUserId: actor.id },
    })
    .returning();
  await tx.insert(auditLogsTable).values({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email ?? "",
    actorRole: actor.role,
    action,
    resourceType: "tenant_print_controls",
    resourceId: String(tenantId),
    metadata: { previous: values(previous), next, version },
  });
  return toControls(row);
}

export type UpdatePrintControlsResult =
  | { status: "updated"; controls: PrintControls }
  | { status: "conflict"; controls: PrintControls };

/**
 * Applies only the flags supplied, and only if the tenant's controls are
 * still at `expectedVersion`; otherwise nothing changes and the current
 * controls are returned so the caller can re-read and retry deliberately.
 */
export async function updatePrintControls(input: {
  tenantId: number;
  actor: PrintControlActor;
  expectedVersion: number;
  changes: Partial<PrintControlValues>;
}): Promise<UpdatePrintControlsResult> {
  return db.transaction(async (tx) => {
    const previous = toControls(await readRow(tx, input.tenantId, true));
    if (previous.version !== input.expectedVersion) return { status: "conflict", controls: previous };
    const next = { ...values(previous) };
    for (const flag of PRINT_CONTROL_FLAGS) {
      const change = input.changes[flag];
      if (typeof change === "boolean") next[flag] = change;
    }
    const controls = await writeControls(tx, input.tenantId, input.actor, previous, next, "PRINT_CONTROLS_UPDATED");
    return { status: "updated", controls };
  });
}

/** Turns all automatic printing OFF for the tenant in one statement. */
export async function pauseAllPrintControls(input: { tenantId: number; actor: PrintControlActor }): Promise<PrintControls> {
  return db.transaction(async (tx) => {
    const previous = toControls(await readRow(tx, input.tenantId, true));
    return writeControls(tx, input.tenantId, input.actor, previous, { ...OFF }, "PRINT_CONTROLS_PAUSED_ALL");
  });
}

