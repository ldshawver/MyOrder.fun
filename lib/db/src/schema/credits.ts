import {
  bigserial,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { ordersTable } from "./orders";
import { paymentAttemptsTable, paymentRefundsTable } from "./payments";

export const userCreditsTable = pgTable("user_credits", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  reason: text("reason"),
  source: text("source").notNull().default("admin_adjustment"),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserCredit = typeof userCreditsTable.$inferSelect;
export type InsertUserCredit = typeof userCreditsTable.$inferInsert;

export const customerCreditAccountsTable = pgTable("customer_credit_accounts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  customerId: integer("customer_id").notNull(),
  balance: numeric("balance", { precision: 12, scale: 2 }).notNull().default("0"),
  reservedBalance: numeric("reserved_balance", { precision: 12, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => ({
  tenantIdUnique: unique("customer_credit_accounts_tenant_id_unique").on(table.tenantId, table.id),
  customerUnique: unique("customer_credit_accounts_tenant_customer_unique").on(table.tenantId, table.customerId),
  customerFk: foreignKey({ columns: [table.tenantId, table.customerId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
  balanceCheck: check("customer_credit_accounts_balance_check", sql`${table.balance} >= 0 AND ${table.reservedBalance} >= 0 AND ${table.reservedBalance} <= ${table.balance}`),
}));

export const customerCreditLedgerTable = pgTable("customer_credit_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  accountId: integer("account_id").notNull(), customerId: integer("customer_id").notNull(),
  entryType: text("entry_type").notNull(), amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  reason: text("reason").notNull(), actorUserId: integer("actor_user_id").notNull(),
  orderId: integer("order_id"), paymentAttemptId: integer("payment_attempt_id"), paymentRefundId: integer("payment_refund_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  tenantIdUnique: unique("customer_credit_ledger_tenant_id_unique").on(table.tenantId, table.id),
  idempotencyUnique: unique("customer_credit_ledger_tenant_key_unique").on(table.tenantId, table.idempotencyKey),
  accountFk: foreignKey({ columns: [table.tenantId, table.accountId], foreignColumns: [customerCreditAccountsTable.tenantId, customerCreditAccountsTable.id] }),
  customerFk: foreignKey({ columns: [table.tenantId, table.customerId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
  orderFk: foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [ordersTable.tenantId, ordersTable.id] }),
  paymentAttemptFk: foreignKey({ columns: [table.tenantId, table.paymentAttemptId], foreignColumns: [paymentAttemptsTable.tenantId, paymentAttemptsTable.id] }),
  paymentRefundFk: foreignKey({ columns: [table.tenantId, table.paymentRefundId], foreignColumns: [paymentRefundsTable.tenantId, paymentRefundsTable.id] }),
  actorFk: foreignKey({ columns: [table.tenantId, table.actorUserId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
  accountIndex: index("customer_credit_ledger_account_idx").on(table.tenantId, table.accountId, table.createdAt, table.id),
  nonZeroCheck: check("customer_credit_ledger_nonzero_check", sql`${table.amount} <> 0`),
}));
