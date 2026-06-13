import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const contractsTable = pgTable("contracts", {
  id: text("id").primaryKey(), companyId: text("company_id").notNull(), title: text("title").notNull(), contractorId: text("contractor_id"), approvedProposalContractorUserId: text("approved_proposal_contractor_user_id"), status: text("status").notNull().default("draft"), documensoDocumentId: text("documenso_document_id"), storageKey: text("storage_key"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const contractSignersTable = pgTable("contract_signers", {
  id: text("id").primaryKey(), contractId: text("contract_id").notNull(), companyId: text("company_id").notNull(), contractorId: text("contractor_id"), userId: text("user_id"), email: text("email").notNull(), name: text("name"), signerRole: text("signer_role").notNull().default("signer"), signerType: text("signer_type").notNull(), isRequired: boolean("is_required").notNull().default(true), isDelegated: boolean("is_delegated").notNull().default(false), delegatedByUserId: text("delegated_by_user_id"), replacesSignerId: text("replaces_signer_id"), signingOrder: integer("signing_order").notNull().default(1), status: text("status").notNull().default("pending"), documensoRecipientId: text("documenso_recipient_id"), signingTokenHash: text("signing_token_hash"), signingTokenExpiresAt: timestamp("signing_token_expires_at", { withTimezone: true }), signedAt: timestamp("signed_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});


export const contractAuditLogsTable = pgTable("contract_audit_logs", {
  id: text("id").primaryKey(), contractId: text("contract_id").notNull(), companyId: text("company_id").notNull(), actorUserId: text("actor_user_id"), actorEmail: text("actor_email"), action: text("action").notNull(), beforeJson: jsonb("before_json"), afterJson: jsonb("after_json"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documensoWebhookEventsTable = pgTable("documenso_webhook_events", {
  id: text("id").primaryKey(), eventId: text("event_id").notNull().unique(), contractId: text("contract_id"), documensoDocumentId: text("documenso_document_id"), eventType: text("event_type").notNull(), payload: jsonb("payload"), processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});
