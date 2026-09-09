import { and, eq, sql } from "drizzle-orm";
import {
  auditLogsTable,
  commissionSnapshotsTable,
  db,
  labTechShiftsTable,
  shiftCloseoutPackagesTable,
} from "@workspace/db";
import {
  calculateCloseoutFinancials,
  type CloseoutFinancials,
  requiredMoneyCents,
  ShiftCloseoutFinancialError,
} from "./shiftCloseoutFinancials";

export const SHIFT_13_NAN_REPAIR_REASON = "SHIFT_CLOSEOUT_NAN_REPAIR" as const;
const SHIFT_13_ID = 13;
const REPAIR_KEY = "shift-closeout-nan-repair:1:13";

type RepairActor = { id: number; email?: string | null; role: string; ipAddress?: string | null };
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class Shift13CloseoutNanRepairError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "Shift13CloseoutNanRepairError";
  }
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Shift13CloseoutNanRepairError(409, `${field} is not an object and cannot be safely repaired`);
  }
  return value as Record<string, unknown>;
}

function isInvalidMoney(value: unknown): boolean {
  try {
    requiredMoneyCents(value, "persisted closeout money");
    return false;
  } catch {
    return true;
  }
}

function corruptCloseout(
  shift: { tipAmount: unknown; depositAmount: unknown; summary: unknown },
  snapshot: unknown,
  commission: { qualifyingSales: unknown; commissionBasis: unknown; commissionAmount: unknown },
): boolean {
  const summary = record(shift.summary, "shift summary");
  const packageSnapshot = record(snapshot, "closeout package snapshot");
  return [
    shift.tipAmount, shift.depositAmount,
    summary.eligibleSalesBase, summary.tipAmount, summary.finalTip, summary.depositAmount, summary.newCashBalance,
    packageSnapshot.eligibleSalesBase, packageSnapshot.tipAmount, packageSnapshot.finalTip, packageSnapshot.depositAmount, packageSnapshot.newCashBalance,
    commission.qualifyingSales, commission.commissionBasis, commission.commissionAmount,
  ].some(isInvalidMoney);
}

function financialSnapshot(current: Record<string, unknown>, financials: CloseoutFinancials, tipPercent: number): Record<string, unknown> {
  return {
    ...current,
    eligibleSalesBase: financials.eligibleSalesBase,
    tipPercent,
    tipAmount: financials.tipAmount,
    differenceAmount: financials.differenceAmount,
    finalTip: financials.finalTip,
    cashBankStart: financials.cashBankStart,
    cashBankEndReported: financials.cashBankEndReported,
    depositAmount: financials.depositAmount,
    newCashBalance: financials.newCashBalance,
    employeeDiscountSales: financials.employeeDiscountSales,
  };
}

type SourceEvidence = {
  orderCount: string;
  nonUnpaidOrderCount: string;
  paidOrderCount: string;
  paymentAttemptCount: string;
  capturedPaymentCount: string;
  cashLedgerEntryCount: string;
  cashLedgerAmount: string;
  inventoryShortageAmount: string;
};

async function authoritativeZeroRevenueEvidence(tx: DbTransaction, tenantId: number): Promise<SourceEvidence> {
  const result = await tx.execute(sql`
    SELECT
      (SELECT count(*) FROM orders WHERE tenant_id = ${tenantId} AND assigned_shift_id = ${SHIFT_13_ID})::text AS "orderCount",
      (SELECT count(*) FROM orders WHERE tenant_id = ${tenantId} AND assigned_shift_id = ${SHIFT_13_ID} AND payment_status <> 'unpaid')::text AS "nonUnpaidOrderCount",
      (SELECT count(*) FROM orders WHERE tenant_id = ${tenantId} AND assigned_shift_id = ${SHIFT_13_ID} AND payment_status = 'paid')::text AS "paidOrderCount",
      (SELECT count(*) FROM payment_attempts a JOIN orders o ON o.id = a.order_id WHERE o.tenant_id = ${tenantId} AND o.assigned_shift_id = ${SHIFT_13_ID})::text AS "paymentAttemptCount",
      (SELECT count(*) FROM payment_captures c JOIN payment_attempts a ON a.id = c.payment_attempt_id JOIN orders o ON o.id = a.order_id WHERE o.tenant_id = ${tenantId} AND o.assigned_shift_id = ${SHIFT_13_ID} AND c.state IN ('captured', 'completed', 'succeeded'))::text AS "capturedPaymentCount",
      (SELECT count(*) FROM cash_ledger_entries WHERE tenant_id = ${tenantId} AND shift_id = ${SHIFT_13_ID})::text AS "cashLedgerEntryCount",
      (SELECT coalesce(sum(amount), 0)::text FROM cash_ledger_entries WHERE tenant_id = ${tenantId} AND shift_id = ${SHIFT_13_ID}) AS "cashLedgerAmount",
      (SELECT coalesce(sum(sii.discrepancy * sii.unit_price) FILTER (WHERE sii.is_flagged = true AND sii.discrepancy > 0), 0)::text FROM shift_inventory_items sii WHERE sii.shift_id = ${SHIFT_13_ID}) AS "inventoryShortageAmount"
  `);
  const source = rows<SourceEvidence>(result)[0];
  if (!source) throw new Shift13CloseoutNanRepairError(409, "Unable to read authoritative Shift 13 financial records");
  return source;
}

function sourceMustBeUnambiguous(source: SourceEvidence): void {
  const nonZeroCounts = [source.nonUnpaidOrderCount, source.paidOrderCount, source.paymentAttemptCount, source.capturedPaymentCount, source.cashLedgerEntryCount]
    .some(value => Number(value) !== 0);
  if (nonZeroCounts || requiredMoneyCents(source.cashLedgerAmount, "cash ledger amount") !== 0n) {
    throw new Shift13CloseoutNanRepairError(409, "Shift 13 financial sources are not the approved zero-revenue repair case");
  }
}

function assertActor(actor: RepairActor): void {
  if (!Number.isInteger(actor.id) || actor.id <= 0 || !["global_admin", "admin", "supervisor"].includes(actor.role)) {
    throw new Shift13CloseoutNanRepairError(403, "Global admin, admin, or supervisor permission is required");
  }
}

export type Shift13CloseoutNanRepairResult = {
  shiftId: 13;
  idempotent: boolean;
  financials: Pick<CloseoutFinancials, "tipAmount" | "depositAmount" | "finalTip" | "qualifyingSales" | "eligibleSalesBase">;
};

/**
 * Deliberately targets only the known historical incident. It cannot be used as
 * a generic closeout editor and only runs when the persisted record is corrupt.
 */
export async function repairShift13CloseoutNan(actor: RepairActor): Promise<Shift13CloseoutNanRepairResult> {
  assertActor(actor);
  return db.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
    await tx.execute(sql`SELECT set_config('app.shift_closeout_nan_repair', 'SHIFT_CLOSEOUT_NAN_REPAIR:13', true)`);
    const [shift] = await tx.select().from(labTechShiftsTable)
      .where(and(eq(labTechShiftsTable.id, SHIFT_13_ID), eq(labTechShiftsTable.tenantId, 1))).for("update").limit(1);
    if (!shift || shift.status !== "finalized") throw new Shift13CloseoutNanRepairError(409, "Shift 13 must be finalized before repair");
    const [pkg] = await tx.select().from(shiftCloseoutPackagesTable)
      .where(and(eq(shiftCloseoutPackagesTable.tenantId, shift.tenantId), eq(shiftCloseoutPackagesTable.shiftId, SHIFT_13_ID))).for("update").limit(1);
    const [commission] = await tx.select().from(commissionSnapshotsTable)
      .where(and(eq(commissionSnapshotsTable.tenantId, shift.tenantId), eq(commissionSnapshotsTable.shiftId, SHIFT_13_ID))).for("update").limit(1);
    if (!pkg || !commission) throw new Shift13CloseoutNanRepairError(409, "Shift 13 closeout records are incomplete and cannot be safely repaired");

    const previousSummary = record(shift.summary, "shift summary");
    const previousPackage = record(pkg.snapshotJson, "closeout package snapshot");
    const wasCorrupt = corruptCloseout(shift, pkg.snapshotJson, commission);
    const repairAudit = await tx.execute(sql`SELECT id FROM audit_logs WHERE tenant_id = ${shift.tenantId} AND action = ${SHIFT_13_NAN_REPAIR_REASON} AND resource_id = ${String(SHIFT_13_ID)} AND metadata->>'repairKey' = ${REPAIR_KEY} LIMIT 1`);
    if (rows(repairAudit).length > 0) {
      if (wasCorrupt) throw new Shift13CloseoutNanRepairError(409, "Shift 13 repair audit exists but invalid monetary state remains");
      return { shiftId: SHIFT_13_ID, idempotent: true, financials: { tipAmount: Number(shift.tipAmount), depositAmount: Number(shift.depositAmount), finalTip: Number(previousSummary.finalTip), qualifyingSales: Number(commission.qualifyingSales), eligibleSalesBase: Number(commission.commissionBasis) } };
    }
    if (!wasCorrupt) throw new Shift13CloseoutNanRepairError(409, "Shift 13 is not corrupted; this maintenance repair is refused");

    const source = await authoritativeZeroRevenueEvidence(tx, shift.tenantId);
    sourceMustBeUnambiguous(source);
    const tipPercent = Number(shift.tipPercentSelected);
    const financials = calculateCloseoutFinancials({
      totalRevenue: "0.00", cashSales: source.cashLedgerAmount, compSales: undefined, employeeDiscountSales: "0.00",
      cashBankStart: shift.cashBankStart, cashBankEndReported: shift.cashBankEndReported,
      differenceAmount: source.inventoryShortageAmount, tipPercent,
    });
    const expectedCash = requiredMoneyCents(shift.cashBankStart, "cashBankStart") + requiredMoneyCents(source.cashLedgerAmount, "cashLedgerAmount");
    if (requiredMoneyCents(shift.cashBankEndReported, "cashBankEndReported") !== expectedCash) {
      throw new Shift13CloseoutNanRepairError(409, "Shift 13 reported cash does not reconcile to authoritative cash ledger");
    }

    const repairedSummary = financialSnapshot(previousSummary, financials, tipPercent);
    const repairedPackage = financialSnapshot(previousPackage, financials, tipPercent);
    const before = {
      shift: { tipAmount: String(shift.tipAmount), depositAmount: String(shift.depositAmount) },
      package: { eligibleSalesBase: previousPackage.eligibleSalesBase, tipAmount: previousPackage.tipAmount, finalTip: previousPackage.finalTip, depositAmount: previousPackage.depositAmount, newCashBalance: previousPackage.newCashBalance },
      commission: { qualifyingSales: String(commission.qualifyingSales), commissionBasis: String(commission.commissionBasis), commissionAmount: String(commission.commissionAmount) },
    };
    const after = {
      shift: { tipAmount: financials.persistence.tipAmount, depositAmount: financials.persistence.depositAmount },
      package: { eligibleSalesBase: financials.eligibleSalesBase, tipAmount: financials.tipAmount, finalTip: financials.finalTip, depositAmount: financials.depositAmount, newCashBalance: financials.newCashBalance },
      commission: { qualifyingSales: financials.persistence.qualifyingSales, commissionBasis: financials.persistence.commissionBasis, commissionAmount: financials.persistence.commissionAmount },
    };

    await tx.update(labTechShiftsTable).set({ tipAmount: financials.persistence.tipAmount, depositAmount: financials.persistence.depositAmount, summary: repairedSummary, updatedAt: new Date() })
      .where(and(eq(labTechShiftsTable.id, SHIFT_13_ID), eq(labTechShiftsTable.tenantId, shift.tenantId)));
    await tx.update(shiftCloseoutPackagesTable).set({ snapshotJson: repairedPackage })
      .where(and(eq(shiftCloseoutPackagesTable.id, pkg.id), eq(shiftCloseoutPackagesTable.tenantId, shift.tenantId)));
    await tx.update(commissionSnapshotsTable).set({
      qualifyingSales: financials.persistence.qualifyingSales, commissionBasis: financials.persistence.commissionBasis,
      commissionRate: financials.persistence.commissionRate, adjustments: financials.persistence.adjustments,
      commissionAmount: financials.persistence.commissionAmount,
    }).where(and(eq(commissionSnapshotsTable.id, commission.id), eq(commissionSnapshotsTable.tenantId, shift.tenantId)));
    await tx.insert(auditLogsTable).values({
      tenantId: shift.tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role,
      action: SHIFT_13_NAN_REPAIR_REASON, resourceType: "lab_tech_shift", resourceId: String(SHIFT_13_ID),
      metadata: { repairKey: REPAIR_KEY, reason: SHIFT_13_NAN_REPAIR_REASON, source, before, after }, ipAddress: actor.ipAddress ?? null,
    });
    return { shiftId: SHIFT_13_ID, idempotent: false, financials: { tipAmount: financials.tipAmount, depositAmount: financials.depositAmount, finalTip: financials.finalTip, qualifyingSales: financials.qualifyingSales, eligibleSalesBase: financials.eligibleSalesBase } };
  }).catch(error => {
    if (error instanceof ShiftCloseoutFinancialError) throw new Shift13CloseoutNanRepairError(409, error.message);
    throw error;
  });
}
