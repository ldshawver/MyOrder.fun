import { and, eq, isNull, sql } from "drizzle-orm";
import { db, labTechShiftsTable } from "@workspace/db";

// Serialize transitions between the tenant-wide fallback and CSR cash modes.
export function lockQueueOperatingMode(tx: Pick<typeof db, "execute">, tenantId: number) {
  return tx.execute(sql`select pg_advisory_xact_lock(${tenantId}, -740016)`);
}

export async function hasClockedInCsrShift(tenantId: number, connection: Pick<typeof db, "select"> = db) {
  const [shift] = await connection.select({ id: labTechShiftsTable.id }).from(labTechShiftsTable)
    .where(and(
      eq(labTechShiftsTable.tenantId, tenantId),
      eq(labTechShiftsTable.status, "active"),
      isNull(labTechShiftsTable.clockedOutAt),
    )).limit(1);
  return Boolean(shift);
}
