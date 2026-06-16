import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const documentAssetsTable = pgTable("document_assets", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  ownerUserId: text("owner_user_id"),
  relatedEmployeeId: text("related_employee_id"),
  relatedContractorId: text("related_contractor_id"),
  relatedProposalId: text("related_proposal_id"),
  relatedContractId: text("related_contract_id"),
  relatedInvoiceId: text("related_invoice_id"),
  sourceModule: text("source_module").notNull(),
  sourceType: text("source_type"),
  documentType: text("document_type").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  fileName: text("file_name").notNull(),
  fileMimeType: text("file_mime_type").notNull(),
  fileSize: integer("file_size").notNull().default(0),
  storageProvider: text("storage_provider").notNull().default("local"),
  storageKey: text("storage_key").notNull(),
  publicUrl: text("public_url"),
  signedUrl: text("signed_url"),
  status: text("status").notNull().default("active"),
  versionNumber: integer("version_number").notNull().default(1),
  isFinal: boolean("is_final").notNull().default(false),
  isArchived: boolean("is_archived").notNull().default(false),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const documentAssetMetadataTable = pgTable("document_asset_metadata", {
  id: text("id").primaryKey(),
  documentAssetId: text("document_asset_id").notNull().references(() => documentAssetsTable.id, { onDelete: "cascade" }),
  metadataKey: text("metadata_key").notNull(),
  metadataValue: text("metadata_value"),
  metadataType: text("metadata_type").notNull().default("string"),
  isEditableByUser: boolean("is_editable_by_user").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const documentAssetPermissionsTable = pgTable("document_asset_permissions", {
  id: text("id").primaryKey(), documentAssetId: text("document_asset_id").notNull().references(() => documentAssetsTable.id, { onDelete: "cascade" }), companyId: text("company_id").notNull(), userId: text("user_id"), role: text("role"), permissionView: boolean("permission_view").notNull().default(true), permissionDownload: boolean("permission_download").notNull().default(false), permissionPrint: boolean("permission_print").notNull().default(false), permissionEditMetadata: boolean("permission_edit_metadata").notNull().default(false), permissionDelete: boolean("permission_delete").notNull().default(false), permissionShare: boolean("permission_share").notNull().default(false), expiresAt: timestamp("expires_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const documentAssetVersionsTable = pgTable("document_asset_versions", {
  id: text("id").primaryKey(), documentAssetId: text("document_asset_id").notNull().references(() => documentAssetsTable.id, { onDelete: "cascade" }), versionNumber: integer("version_number").notNull(), storageKey: text("storage_key").notNull(), fileName: text("file_name").notNull(), fileMimeType: text("file_mime_type").notNull(), fileSize: integer("file_size").notNull().default(0), createdByUserId: text("created_by_user_id"), changeSummary: text("change_summary"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentAssetAuditLogsTable = pgTable("document_asset_audit_logs", {
  id: text("id").primaryKey(), documentAssetId: text("document_asset_id").notNull().references(() => documentAssetsTable.id, { onDelete: "cascade" }), companyId: text("company_id").notNull(), actorUserId: text("actor_user_id"), actorEmail: text("actor_email"), action: text("action").notNull(), beforeJson: jsonb("before_json"), afterJson: jsonb("after_json"), ipAddress: text("ip_address"), userAgent: text("user_agent"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
