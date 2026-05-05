import {
  pgTable,
  serial,
  integer,
  boolean,
  text,
  timestamp,
  numeric,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const adminSettingsTable = pgTable("admin_settings", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  // Product
  menuImportEnabled: boolean("menu_import_enabled").notNull().default(true),
  showOutOfStock: boolean("show_out_of_stock").notNull().default(false),
  // Checkout
  enabledProcessors: text("enabled_processors").array().notNull().default(["stripe"]),
  checkoutConversionPreview: boolean("checkout_conversion_preview").notNull().default(false),
  merchantImageEnabled: boolean("merchant_image_enabled").notNull().default(true),
  // Printing
  autoPrintOnPayment: boolean("auto_print_on_payment").notNull().default(false),
  receiptTemplateStyle: text("receipt_template_style").notNull().default("standard"),
  labelTemplateStyle: text("label_template_style").notNull().default("standard"),
  // Purge
  purgeMode: text("purge_mode").notNull().default("delayed"), // immediate | delayed | partial
  purgeDelayHours: integer("purge_delay_hours").notNull().default(72),
  keepAuditToken: boolean("keep_audit_token").notNull().default(true),
  keepFailedPaymentLogs: boolean("keep_failed_payment_logs").notNull().default(true),
  pettyCash: numeric("petty_cash", { precision: 10, scale: 2 }).default("0"),
  receiptLineNameMode: text("receipt_line_name_mode").notNull().default("lucifer_only"),
  // WooCommerce integration credentials.
  // Consumer key/secret are stored as AES-256-GCM ciphertext (see api-server lib/crypto.ts).
  wcStoreUrl: text("wc_store_url").default("https://lucifercruz.com"),
  wcConsumerKey: text("wc_consumer_key"),
  wcConsumerSecret: text("wc_consumer_secret"),
  wcEnabled: boolean("wc_enabled").notNull().default(true),
  // Task #12: Order routing rule
  //   round_robin | least_recent_order | supervisor_manual_assignment
  orderRoutingRule: text("order_routing_rule").notNull().default("round_robin"),
  // Default ETA (minutes) used to compute customer hourglass when no per-order override is set
  defaultEtaMinutes: integer("default_eta_minutes").notNull().default(30),
  // Admin-editable AI concierge system prompt. NULL → server falls back to
  // DEFAULT_AI_CONCIERGE_PROMPT in routes/ai.ts. Supports placeholders
  // {{itemCount}} and {{catalog}} substituted at request time.
  aiConciergePrompt: text("ai_concierge_prompt"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type AdminSettings = typeof adminSettingsTable.$inferSelect;
export type InsertAdminSettings = typeof adminSettingsTable.$inferInsert;
