import { db, inventoryReservationsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

async function main(): Promise<void> {
  const released = await db.update(inventoryReservationsTable)
    .set({ status: "released", updatedAt: new Date() })
    .where(and(
      eq(inventoryReservationsTable.status, "reserved"),
      sql`${inventoryReservationsTable.expiresAt} <= now()`,
    ))
    .returning({ id: inventoryReservationsTable.id });
  console.log(JSON.stringify({ releasedReservations: released.length }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
