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
import { usersTable } from "./users";

// ── Bridge Profiles ────────────────────────────────────────────────────────────
// Represents a physical print bridge server (Mac Studio or Raspberry Pi).
// Printers reference a bridge profile; routing logic uses profiles to determine
// which bridge to target based on operator network location and priority.
export const printBridgeProfilesTable = pgTable("print_bridge_profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // mac_studio | raspberry_pi | generic
  bridgeType: text("bridge_output").notNull().default("generic"),
  bridgeUrl: text("bridge_url").notNull(),
  apiKey: text("api_key").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  // Lower number = higher priority (1 = most preferred)
  priority: integer("priority").notNull().default(10),
  // Server-side same-network detection: compare operator IP prefix (e.g. "192.168.1.")
  networkSubnetHint: text("network_subnet_hint"),
  // receipt | label | both
  supportedRoles: text("supported_roles").notNull().default("both"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Printers ──────────────────────────────────────────────────────────────────
// connectionType:
//   "ethernet_direct" — raw TCP socket to printer on LAN (receipts)
//   "mac_bridge"      — HTTP to Mac print bridge (labels)
//   "pi_bridge"       — HTTP to Raspberry Pi bridge (receipt fallback)
//   "bridge"          — generic HTTP bridge (legacy)
export const printPrintersTable = pgTable("print_printers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull().default("kitchen"),
  // connection type controls dispatch strategy
  connectionType: text("connection_output").notNull().default("bridge"),
  // Optional link to a bridge profile (overrides bridgeUrl/apiKey when set)
  bridgeProfileId: integer("bridge_profile_id").references(() => printBridgeProfilesTable.id, { onDelete: "set null" }),
  // For ethernet_direct: IP + port for raw socket
  directIp: text("direct_ip"),
  directPort: integer("direct_port").default(9100),
  // For mac_bridge / pi_bridge / bridge: HTTP endpoint (used when no bridgeProfileId)
  bridgeUrl: text("bridge_url").notNull().default(""),
  bridgePrinterName: text("bridge_printer_name"),
  apiKey: text("api_key"),
  isActive: boolean("is_active").notNull().default(true),
  timeoutMs: integer("timeout_ms").notNull().default(8000),
  copies: integer("copies").notNull().default(1),
  paperWidth: text("paper_width").notNull().default("80mm"),
  supportsCut: boolean("supports_cut").notNull().default(true),
  supportsCashDrawer: boolean("supports_cash_drawer").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Operator Print Profiles ────────────────────────────────────────────────────
// Maps a lab tech (or admin) to their specific printers.
// When an order comes in, the active operator's profile is resolved first.
export const operatorPrintProfilesTable = pgTable("operator_print_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  // Ethernet direct printer for receipts
  receiptPrinterId: integer("receipt_printer_id").references(() => printPrintersTable.id, { onDelete: "set null" }),
  // Mac bridge printer for labels
  labelPrinterId: integer("label_printer_id").references(() => printPrintersTable.id, { onDelete: "set null" }),
  // Pi bridge used as receipt fallback when Ethernet is unreachable
  fallbackReceiptPrinterId: integer("fallback_receipt_printer_id").references(() => printPrintersTable.id, { onDelete: "set null" }),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Print Assets ───────────────────────────────────────────────────────────────
// Uploaded PNG/image files used as label template backgrounds.
export const printAssetsTable = pgTable("print_assets", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_output").notNull().default("image/png"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  // Path relative to a configured asset directory on the server
  storagePath: text("storage_path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Print Templates ────────────────────────────────────────────────────────────
// Label / receipt templates. templateJson defines field placements.
// For labels: backgroundAssetId points to a PNG, fields render as text overlay.
export const printTemplatesTable = pgTable("print_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  jobType: text("job_output").notNull().default("label"), // label | receipt | order_ticket
  backgroundAssetId: integer("background_asset_id").references(() => printAssetsTable.id, { onDelete: "set null" }),
  // JSON array of field definitions: [{key, x, y, fontSize, fontWeight, align, maxWidth}]
  templateJson: jsonb("template_json").notNull().default([]),
  paperWidth: text("paper_width").notNull().default("58mm"),
  paperHeight: text("paper_height").notNull().default("auto"),
  isActive: boolean("is_active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Print Jobs ─────────────────────────────────────────────────────────────────
export const printJobsTable = pgTable("print_jobs", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").references(() => ordersTable.id, { onDelete: "set null" }),
  printerId: integer("printer_id").references(() => printPrintersTable.id, { onDelete: "set null" }),
  // which operator was active when the job was created
  operatorUserId: integer("operator_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  jobType: text("job_output").notNull().default("order_ticket"), // order_ticket | receipt | label
  status: text("status").notNull().default("queued"),          // queued | sending | printed | retrying | failed
  idempotencyKey: text("idempotency_key").notNull().unique(),
  renderFormat: text("render_format").notNull().default("text"), // text | png
  payloadJson: jsonb("payload_json").notNull(),
  renderedText: text("rendered_text"),
  // For PNG labels: base64 or file path
  renderedImagePath: text("rendered_image_path"),
  // Which method succeeded (ethernet_direct | mac_bridge | pi_bridge | queued)
  printedVia: text("printed_via"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(5),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  printedAt: timestamp("printed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Print Job Attempts ────────────────────────────────────────────────────────
export const printJobAttemptsTable = pgTable("print_job_attempts", {
  id: serial("id").primaryKey(),
  printJobId: integer("print_job_id").notNull().references(() => printJobsTable.id, { onDelete: "cascade" }),
  attemptNumber: integer("attempt_number").notNull(),
  // which route was tried
  routeUsed: text("route_used"), // ethernet_direct | mac_bridge | pi_bridge | bridge
  requestPayload: jsonb("request_payload"),
  responsePayload: jsonb("response_payload"),
  success: boolean("success").notNull().default(false),
  errorMessage: text("error_message"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Print Settings ─────────────────────────────────────────────────────────────
export const printSettingsTable = pgTable("print_settings", {
  id: serial("id").primaryKey(),
  autoPrintOrders: boolean("auto_print_orders").notNull().default(true),
  autoPrintReceipts: boolean("auto_print_receipts").notNull().default(false),
  autoPrintLabels: boolean("auto_print_labels").notNull().default(false),
  retryBackoffBaseMs: integer("retry_backoff_base_ms").notNull().default(3000),
  staleJobMinutes: integer("stale_job_minutes").notNull().default(5),
  alertOnLabelFailure: boolean("alert_on_label_failure").notNull().default(true),
  // ── Receipt appearance ───────────────────────────────────────────────────────
  includeLogo: boolean("include_logo").notNull().default(true),
  includeOperatorName: boolean("include_operator_name").notNull().default(true),
  showDiscreetNotice: boolean("show_discreet_notice").notNull().default(false),
  paperWidth: text("paper_width").notNull().default("80mm"),
  brandName: text("brand_name"),
  footerMessage: text("footer_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Types ─────────────────────────────────────────────────────────────────────
export type PrintBridgeProfile = typeof printBridgeProfilesTable.$inferSelect;
export type PrintPrinter = typeof printPrintersTable.$inferSelect;
export type PrintJob = typeof printJobsTable.$inferSelect;
export type PrintJobAttempt = typeof printJobAttemptsTable.$inferSelect;
export type PrintSettings = typeof printSettingsTable.$inferSelect;
export type OperatorPrintProfile = typeof operatorPrintProfilesTable.$inferSelect;
export type PrintTemplate = typeof printTemplatesTable.$inferSelect;
export type PrintAsset = typeof printAssetsTable.$inferSelect;
