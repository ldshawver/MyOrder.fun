import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { ordersTable } from "./orders";

export const printPrintersTable = pgTable("print_printers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull().default("kitchen"),
  type: text("type").notNull().default("usb"),
  isActive: boolean("is_active").notNull().default(true),
  bridgeUrl: text("bridge_url").notNull(),
  bridgePrinterName: text("bridge_printer_name"),
  apiKey: text("api_key"),
  timeoutMs: integer("timeout_ms").notNull().default(8000),
  copies: integer("copies").notNull().default(1),
  paperWidth: text("paper_width").notNull().default("80mm"),
  supportsCut: boolean("supports_cut").notNull().default(true),
  supportsCashDrawer: boolean("supports_cash_drawer").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const printJobsTable = pgTable("print_jobs", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").references(() => ordersTable.id, { onDelete: "set null" }),
  printerId: integer("printer_id").references(() => printPrintersTable.id, { onDelete: "set null" }),
  jobType: text("job_type").notNull().default("order_ticket"),
  status: text("status").notNull().default("queued"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  renderFormat: text("render_format").notNull().default("text"),
  payloadJson: jsonb("payload_json").notNull(),
  renderedText: text("rendered_text"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(5),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  printedAt: timestamp("printed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const printJobAttemptsTable = pgTable("print_job_attempts", {
  id: serial("id").primaryKey(),
  printJobId: integer("print_job_id").notNull().references(() => printJobsTable.id, { onDelete: "cascade" }),
  attemptNumber: integer("attempt_number").notNull(),
  requestPayload: jsonb("request_payload"),
  responsePayload: jsonb("response_payload"),
  success: boolean("success").notNull().default(false),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const printSettingsTable = pgTable("print_settings", {
  id: serial("id").primaryKey(),
  autoPrintOrders: boolean("auto_print_orders").notNull().default(true),
  autoPrintReceipts: boolean("auto_print_receipts").notNull().default(false),
  retryBackoffBaseMs: integer("retry_backoff_base_ms").notNull().default(3000),
  staleJobMinutes: integer("stale_job_minutes").notNull().default(5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type PrintPrinter = typeof printPrintersTable.$inferSelect;
export type PrintJob = typeof printJobsTable.$inferSelect;
export type PrintJobAttempt = typeof printJobAttemptsTable.$inferSelect;
export type PrintSettings = typeof printSettingsTable.$inferSelect;
