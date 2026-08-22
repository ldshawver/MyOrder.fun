import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  boolean,
  jsonb,
  unique,
  uniqueIndex,
  index,
  foreignKey,
  check,
  numeric,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ordersTable } from "./orders";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";
import { inventoryLocationsTable, labTechShiftsTable } from "./shifts";

// ── Bridge Profiles ────────────────────────────────────────────────────────────
// Represents a physical print bridge server (Mac Studio or Raspberry Pi).
// Printers reference a bridge profile; routing logic uses profiles to determine
// which bridge to target based on operator network location and priority.
export const printBridgeProfilesTable = pgTable("print_bridge_profiles", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  locationId: integer("location_id"),
  routingScope: text("routing_scope").notNull().default("general"),
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
  bridgeId: text("bridge_id"),
  environment: text("environment").notNull().default("production"),
  allowedJobType: text("allowed_job_type"),
  credentialHash: text("credential_hash"),
  bridgeVersion: text("bridge_version"),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  lastPrinterAvailability: text("last_printer_availability"),
  lastPrinterReason: text("last_printer_reason"),
  lastPrinterCheckedAt: timestamp("last_printer_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantIdUnique: unique("print_bridge_profiles_tenant_id_unique").on(table.tenantId, table.id),
  tenantLocationIdUnique: unique("print_bridge_profiles_tenant_location_id_unique").on(table.tenantId, table.locationId, table.id),
  tenantLocationFk: foreignKey({ columns: [table.tenantId, table.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }),
  scopeCheck: check("print_bridge_profiles_scope_check", sql`(${table.routingScope} = 'general' AND ${table.locationId} IS NULL) OR (${table.routingScope} = 'location' AND ${table.locationId} IS NOT NULL)`),
}));

// ── Printers ──────────────────────────────────────────────────────────────────
// connectionType:
//   "ethernet_direct" — raw TCP socket to printer on LAN (receipts)
//   "mac_bridge"      — HTTP to Mac print bridge (labels)
//   "pi_bridge"       — HTTP to Raspberry Pi bridge (receipt fallback)
//   "bridge"          — generic HTTP bridge (legacy)
export const printPrintersTable = pgTable("print_printers", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  locationId: integer("location_id"),
  routingScope: text("routing_scope").notNull().default("general"),
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
  expectedDeviceUriHash: text("expected_device_uri_hash"),
  receiptCapable: boolean("receipt_capable").notNull().default(true),
  labelCapable: boolean("label_capable").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantIdUnique: unique("print_printers_tenant_id_unique").on(table.tenantId, table.id),
  tenantLocationIdUnique: unique("print_printers_tenant_location_id_unique").on(table.tenantId, table.locationId, table.id),
  tenantLocationFk: foreignKey({ columns: [table.tenantId, table.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }),
  tenantBridgeFk: foreignKey({ columns: [table.tenantId, table.bridgeProfileId], foreignColumns: [printBridgeProfilesTable.tenantId, printBridgeProfilesTable.id] }),
  tenantBridgeLocationFk: foreignKey({ columns: [table.tenantId, table.locationId, table.bridgeProfileId], foreignColumns: [printBridgeProfilesTable.tenantId, printBridgeProfilesTable.locationId, printBridgeProfilesTable.id] }),
  scopeCheck: check("print_printers_scope_check", sql`(${table.routingScope} = 'general' AND ${table.locationId} IS NULL) OR (${table.routingScope} = 'location' AND ${table.locationId} IS NOT NULL)`),
  queueUnique: uniqueIndex("print_printers_tenant_bridge_queue_unique").on(table.tenantId, table.bridgeProfileId, table.bridgePrinterName),
  routeIndex: index("print_printers_tenant_location_role_idx").on(table.tenantId, table.locationId, table.role),
}));

// ── Operator Print Profiles ────────────────────────────────────────────────────
// Maps a lab tech (or admin) to their specific printers.
// When an order comes in, the active operator's profile is resolved first.
export const operatorPrintProfilesTable = pgTable("operator_print_profiles", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  locationId: integer("location_id"),
  shiftId: integer("shift_id"),
  // Ethernet direct printer for receipts
  receiptPrinterId: integer("receipt_printer_id").references(() => printPrintersTable.id, { onDelete: "set null" }),
  // Mac bridge printer for labels
  labelPrinterId: integer("label_printer_id").references(() => printPrintersTable.id, { onDelete: "set null" }),
  expoPrinterId: integer("expo_printer_id").references(() => printPrintersTable.id, { onDelete: "set null" }),
  printExpoTickets: boolean("print_expo_tickets").notNull().default(false),
  // Pi bridge used as receipt fallback when Ethernet is unreachable
  fallbackReceiptPrinterId: integer("fallback_receipt_printer_id").references(() => printPrintersTable.id, { onDelete: "set null" }),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantUserFk: foreignKey({ columns: [table.tenantId, table.userId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
  tenantLocationFk: foreignKey({ columns: [table.tenantId, table.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }),
  tenantShiftFk: foreignKey({ columns: [table.tenantId, table.shiftId], foreignColumns: [labTechShiftsTable.tenantId, labTechShiftsTable.id] }),
  tenantReceiptFk: foreignKey({ columns: [table.tenantId, table.receiptPrinterId], foreignColumns: [printPrintersTable.tenantId, printPrintersTable.id] }),
  tenantLabelFk: foreignKey({ columns: [table.tenantId, table.labelPrinterId], foreignColumns: [printPrintersTable.tenantId, printPrintersTable.id] }),
  tenantExpoFk: foreignKey({ columns: [table.tenantId, table.expoPrinterId], foreignColumns: [printPrintersTable.tenantId, printPrintersTable.id] }),
  noFallbackCheck: check("operator_print_profiles_no_fallback_check", sql`${table.fallbackReceiptPrinterId} IS NULL`),
}));

// ── Print Assets ───────────────────────────────────────────────────────────────
// Uploaded PNG/image files used as label template backgrounds.
export const printAssetsTable = pgTable("print_assets", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_output").notNull().default("image/png"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  // Path relative to a configured asset directory on the server
  storagePath: text("storage_path").notNull(),
  contentSha256: text("content_sha256").notNull(),
  widthPx: integer("width_px").notNull(),
  heightPx: integer("height_px").notNull(),
  createdByUserId: integer("created_by_user_id").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantIdUnique: unique("print_assets_tenant_id_unique").on(table.tenantId, table.id),
  creatorFk: foreignKey({ columns: [table.tenantId, table.createdByUserId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
  hashUnique: uniqueIndex("print_assets_tenant_hash_unique").on(table.tenantId, table.contentSha256),
}));

// ── Print Templates ────────────────────────────────────────────────────────────
// Label / receipt templates. templateJson defines field placements.
// For labels: backgroundAssetId points to a PNG, fields render as text overlay.
export const printTemplatesTable = pgTable("print_templates", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  name: text("name").notNull(),
  jobType: text("job_output").notNull().default("label"), // label | receipt | order_ticket
  backgroundAssetId: integer("background_asset_id").references(() => printAssetsTable.id, { onDelete: "set null" }),
  // JSON array of field definitions: [{key, x, y, fontSize, fontWeight, align, maxWidth}]
  templateJson: jsonb("template_json").notNull().default([]),
  version: integer("version").notNull().default(1),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdByUserId: integer("created_by_user_id"),
  paperWidth: text("paper_width").notNull().default("58mm"),
  paperHeight: text("paper_height").notNull().default("auto"),
  isActive: boolean("is_active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantIdUnique: unique("print_templates_tenant_id_unique").on(table.tenantId, table.id),
  assetFk: foreignKey({ columns: [table.tenantId, table.backgroundAssetId], foreignColumns: [printAssetsTable.tenantId, printAssetsTable.id] }),
  creatorFk: foreignKey({ columns: [table.tenantId, table.createdByUserId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
}));

export const printTemplateVersionsTable = pgTable("print_template_versions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  templateId: integer("template_id").notNull(),
  version: integer("version").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  templateJson: jsonb("template_json").notNull(),
  backgroundAssetId: integer("background_asset_id"),
  paperWidth: text("paper_width").notNull(),
  paperHeight: text("paper_height").notNull(),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  versionUnique: unique("print_template_versions_tenant_template_version_unique").on(table.tenantId, table.templateId, table.version),
  templateFk: foreignKey({ columns: [table.tenantId, table.templateId], foreignColumns: [printTemplatesTable.tenantId, printTemplatesTable.id] }),
  assetFk: foreignKey({ columns: [table.tenantId, table.backgroundAssetId], foreignColumns: [printAssetsTable.tenantId, printAssetsTable.id] }),
  creatorFk: foreignKey({ columns: [table.tenantId, table.createdByUserId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
}));

// ── Print Jobs ─────────────────────────────────────────────────────────────────
export const printJobsTable = pgTable("print_jobs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  locationId: integer("location_id"),
  shiftId: integer("shift_id"),
  orderId: integer("order_id").references(() => ordersTable.id, { onDelete: "set null" }),
  printerId: integer("printer_id").references(() => printPrintersTable.id, { onDelete: "set null" }),
  // which operator was active when the job was created
  operatorUserId: integer("operator_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  jobType: text("job_output").notNull().default("order_ticket"), // order_ticket | receipt | label | thank_you_sticker
  status: text("status").notNull().default("queued"),          // queued | sending | printed | retrying | failed
  idempotencyKey: text("idempotency_key").notNull().unique(),
  renderFormat: text("render_format").notNull().default("text"), // text | png
  payloadJson: jsonb("payload_json").notNull(),
  renderedText: text("rendered_text"),
  // For PNG labels: base64 or file path
  renderedImagePath: text("rendered_image_path"),
  templateId: integer("template_id"),
  templateVersion: integer("template_version"),
  artworkChecksum: text("artwork_checksum"),
  bridgeProfileId: integer("bridge_profile_id"),
  approvalState: text("approval_state").notNull().default("not_required"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  submittingAt: timestamp("submitting_at", { withTimezone: true }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  cupsJobId: integer("cups_job_id"),
  cupsRequestId: text("cups_request_id"),
  finalCupsState: text("final_cups_state"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
  copyCount: integer("copy_count").notNull().default(1),
  media: text("media"), resolution: text("resolution"), bridgeVersion: text("bridge_version"),
  submissionAttempts: integer("submission_attempts").notNull().default(0),
  // Which method succeeded (ethernet_direct | mac_bridge | pi_bridge | queued)
  printedVia: text("printed_via"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(5),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  printedAt: timestamp("printed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantIdUnique: unique("print_jobs_tenant_id_unique").on(table.tenantId, table.id),
  orderFk: foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [ordersTable.tenantId, ordersTable.id] }),
  printerFk: foreignKey({ columns: [table.tenantId, table.printerId], foreignColumns: [printPrintersTable.tenantId, printPrintersTable.id] }),
  operatorFk: foreignKey({ columns: [table.tenantId, table.operatorUserId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
  locationFk: foreignKey({ columns: [table.tenantId, table.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }),
  shiftFk: foreignKey({ columns: [table.tenantId, table.shiftId], foreignColumns: [labTechShiftsTable.tenantId, labTechShiftsTable.id] }),
  templateFk: foreignKey({ columns: [table.tenantId, table.templateId], foreignColumns: [printTemplatesTable.tenantId, printTemplatesTable.id] }),
  routeIndex: index("print_jobs_tenant_location_status_idx").on(table.tenantId, table.locationId, table.status),
}));

// ── Print Job Attempts ────────────────────────────────────────────────────────
export const printJobAttemptsTable = pgTable("print_job_attempts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
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
}, (table) => ({
  jobFk: foreignKey({ columns: [table.tenantId, table.printJobId], foreignColumns: [printJobsTable.tenantId, printJobsTable.id] }),
  jobIndex: index("print_job_attempts_tenant_job_idx").on(table.tenantId, table.printJobId),
}));

export const printRoutesTable = pgTable("print_routes", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  locationId: integer("location_id").notNull(),
  jobType: text("job_type").notNull(),
  bridgeProfileId: integer("bridge_profile_id").notNull(),
  printerId: integer("printer_id").notNull(),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => ({
  routeUnique: unique("print_routes_scope_job_uq").on(table.tenantId, table.locationId, table.jobType),
  locationFk: foreignKey({ columns: [table.tenantId, table.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }),
  bridgeFk: foreignKey({ columns: [table.tenantId, table.bridgeProfileId], foreignColumns: [printBridgeProfilesTable.tenantId, printBridgeProfilesTable.id] }),
  printerFk: foreignKey({ columns: [table.tenantId, table.printerId], foreignColumns: [printPrintersTable.tenantId, printPrintersTable.id] }),
}));

export const shiftPrintAssignmentsTable = pgTable("shift_print_assignments", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  shiftId: integer("shift_id").notNull(),
  locationId: integer("location_id").notNull(),
  receiptPrinterId: integer("receipt_printer_id"),
  expoPrinterId: integer("expo_printer_id"),
  printExpoTickets: boolean("print_expo_tickets").notNull().default(false),
  assignedByUserId: integer("assigned_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  shiftUnique: unique("shift_print_assignments_tenant_shift_unique").on(table.tenantId, table.shiftId),
  shiftFk: foreignKey({ columns: [table.tenantId, table.shiftId], foreignColumns: [labTechShiftsTable.tenantId, labTechShiftsTable.id] }),
  locationFk: foreignKey({ columns: [table.tenantId, table.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }),
  receiptFk: foreignKey({ columns: [table.tenantId, table.locationId, table.receiptPrinterId], foreignColumns: [printPrintersTable.tenantId, printPrintersTable.locationId, printPrintersTable.id] }),
  expoFk: foreignKey({ columns: [table.tenantId, table.locationId, table.expoPrinterId], foreignColumns: [printPrintersTable.tenantId, printPrintersTable.locationId, printPrintersTable.id] }),
  actorFk: foreignKey({ columns: [table.tenantId, table.assignedByUserId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
}));

export const orderTaxSnapshotsTable = pgTable("order_tax_snapshots", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  orderId: integer("order_id").notNull(),
  jurisdiction: text("jurisdiction"),
  locationId: integer("location_id"),
  taxConfigurationId: integer("tax_configuration_id"),
  taxRate: numeric("tax_rate", { precision: 9, scale: 8 }).notNull(),
  grossSales: numeric("gross_sales", { precision: 12, scale: 2 }).notNull().default("0"),
  taxableSubtotal: numeric("taxable_subtotal", { precision: 12, scale: 2 }).notNull(),
  nonTaxableSubtotal: numeric("non_taxable_subtotal", { precision: 12, scale: 2 }).notNull().default("0"),
  discountAmount: numeric("discount_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  cashDiscountAmount: numeric("cash_discount_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  taxCollected: numeric("tax_collected", { precision: 12, scale: 2 }).notNull(),
  taxCalculated: numeric("tax_calculated", { precision: 12, scale: 2 }).notNull().default("0"),
  taxRefunded: numeric("tax_refunded", { precision: 12, scale: 2 }).notNull().default("0"),
  roundingPolicy: text("rounding_policy").notNull().default("round_half_away_from_zero_per_order"),
  tender: text("tender"),
  exemptionReason: text("exemption_reason"),
  snapshotJson: jsonb("snapshot_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orderUnique: unique("order_tax_snapshots_tenant_order_unique").on(table.tenantId, table.orderId),
  orderFk: foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [ordersTable.tenantId, ordersTable.id] }),
}));

export const shiftCloseoutPackagesTable = pgTable("shift_closeout_packages", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  shiftId: integer("shift_id").notNull(), locationId: integer("location_id"), supervisorUserId: integer("supervisor_user_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(), snapshotJson: jsonb("snapshot_json").notNull(),
  sourceMaxUpdatedAt: timestamp("source_max_updated_at", { withTimezone: true }).notNull(), closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  shiftUnique: unique("shift_closeout_packages_tenant_shift_unique").on(table.tenantId, table.shiftId),
  keyUnique: unique("shift_closeout_packages_tenant_key_unique").on(table.tenantId, table.idempotencyKey),
  shiftFk: foreignKey({ columns: [table.tenantId, table.shiftId], foreignColumns: [labTechShiftsTable.tenantId, labTechShiftsTable.id] }),
  locationFk: foreignKey({ columns: [table.tenantId, table.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }),
  supervisorFk: foreignKey({ columns: [table.tenantId, table.supervisorUserId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
}));

export const commissionSnapshotsTable = pgTable("commission_snapshots", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  closeoutPackageId: integer("closeout_package_id").notNull().references(() => shiftCloseoutPackagesTable.id), shiftId: integer("shift_id").notNull(), csrUserId: integer("csr_user_id").notNull(),
  qualifyingSales: numeric("qualifying_sales", { precision: 12, scale: 2 }).notNull(), commissionBasis: numeric("commission_basis", { precision: 12, scale: 2 }).notNull(),
  commissionRate: numeric("commission_rate", { precision: 9, scale: 6 }).notNull(), adjustments: numeric("adjustments", { precision: 12, scale: 2 }).notNull().default("0"),
  commissionAmount: numeric("commission_amount", { precision: 12, scale: 2 }).notNull(), ruleSnapshot: jsonb("rule_snapshot").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  packageUserUnique: unique("commission_snapshots_tenant_package_user_unique").on(table.tenantId, table.closeoutPackageId, table.csrUserId),
  shiftFk: foreignKey({ columns: [table.tenantId, table.shiftId], foreignColumns: [labTechShiftsTable.tenantId, labTechShiftsTable.id] }),
  csrFk: foreignKey({ columns: [table.tenantId, table.csrUserId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
}));

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
  receiptTemplateStyle: text("receipt_template_style").notNull().default("clean"),
  labelTemplateStyle: text("label_template_style").notNull().default("thank_you_personalized"),
  // ── Simplified printer settings (Task #9) ─────────────────────────────────
  // The new simplified UI exposes only the eight fields below. Receipts and
  // labels each have an enabled flag, a method (local CUPS or Tailscale
  // Print Bridge), and a queue / printer name. autoPrintReceipts (above) and
  // lastTestResult round out the eight.
  receiptEnabled: boolean("receipt_enabled").notNull().default(true),
  receiptMethod: text("receipt_method").notNull().default("bridge"),
  receiptPrinterName: text("receipt_printer_name").notNull().default("receipt"),
  labelEnabled: boolean("label_enabled").notNull().default(true),
  labelMethod: text("label_method").notNull().default("local_cups"),
  labelPrinterName: text("label_printer_name").notNull().default("Label_Themal_Printer"),
  // Last test summary: { ts, role, mode, ok, message }
  lastTestResult: jsonb("last_test_result"),
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
