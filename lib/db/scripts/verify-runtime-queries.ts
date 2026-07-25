import { count } from "drizzle-orm";
import {
  cashLedgerEntriesTable,
  db,
  inventoryBalancesTable,
  labTechShiftsTable,
  ordersTable,
  pool,
  printJobsTable,
  usersTable,
} from "../src/index";

const checks = [
  [
    "orders",
    () => db.select({ rows: count(ordersTable.id) }).from(ordersTable),
  ],
  [
    "shifts",
    () =>
      db
        .select({ rows: count(labTechShiftsTable.id) })
        .from(labTechShiftsTable),
  ],
  [
    "printing",
    () => db.select({ rows: count(printJobsTable.id) }).from(printJobsTable),
  ],
  [
    "payments",
    () =>
      db.select({ rows: count(ordersTable.paymentStatus) }).from(ordersTable),
  ],
  [
    "cash_ledger",
    () =>
      db
        .select({ rows: count(cashLedgerEntriesTable.id) })
        .from(cashLedgerEntriesTable),
  ],
  [
    "inventory",
    () =>
      db
        .select({ rows: count(inventoryBalancesTable.id) })
        .from(inventoryBalancesTable),
  ],
  ["users", () => db.select({ rows: count(usersTable.id) }).from(usersTable)],
] as const;

try {
  for (const [area, query] of checks) {
    const [result] = await query();
    console.log(
      `[runtime-schema] ${area}: query ok (aggregate rows=${result?.rows ?? 0})`,
    );
  }
} finally {
  await pool.end();
}
