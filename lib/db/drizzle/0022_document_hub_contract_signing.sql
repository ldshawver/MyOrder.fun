-- Migration: legacy document storage / DAM foundation and legacy module signing support
CREATE TABLE IF NOT EXISTS "document_assets" (
  "id" text PRIMARY KEY,
  "company_id" text NOT NULL,
  "owner_user_id" text,
  "related_employee_id" text,
  "related_contractor_id" text,
  "related_proposal_id" text,
  "related_contract_id" text,
  "related_invoice_id" text,
  "source_module" text NOT NULL,
  "source_type" text,
  "document_type" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "file_name" text NOT NULL,
  "file_mime_type" text NOT NULL,
  "file_size" integer NOT NULL DEFAULT 0,
  "storage_provider" text NOT NULL DEFAULT 'local',
  "storage_key" text NOT NULL,
  "public_url" text,
  "signed_url" text,
  "status" text NOT NULL DEFAULT 'active',
  "version_number" integer NOT NULL DEFAULT 1,
  "is_final" boolean NOT NULL DEFAULT false,
  "is_archived" boolean NOT NULL DEFAULT false,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "document_assets_company_search_idx" ON "document_assets" ("company_id", "document_type", "status", "is_archived");
CREATE TABLE IF NOT EXISTS "document_asset_metadata" ("id" text PRIMARY KEY, "document_asset_id" text NOT NULL REFERENCES "document_assets"("id") ON DELETE CASCADE, "metadata_key" text NOT NULL, "metadata_value" text, "metadata_type" text NOT NULL DEFAULT 'string', "is_editable_by_user" boolean NOT NULL DEFAULT true, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE IF NOT EXISTS "document_asset_permissions" ("id" text PRIMARY KEY, "document_asset_id" text NOT NULL REFERENCES "document_assets"("id") ON DELETE CASCADE, "company_id" text NOT NULL, "user_id" text, "role" text, "permission_view" boolean NOT NULL DEFAULT true, "permission_download" boolean NOT NULL DEFAULT false, "permission_print" boolean NOT NULL DEFAULT false, "permission_edit_metadata" boolean NOT NULL DEFAULT false, "permission_delete" boolean NOT NULL DEFAULT false, "permission_share" boolean NOT NULL DEFAULT false, "expires_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE IF NOT EXISTS "document_asset_versions" ("id" text PRIMARY KEY, "document_asset_id" text NOT NULL REFERENCES "document_assets"("id") ON DELETE CASCADE, "version_number" integer NOT NULL, "storage_key" text NOT NULL, "file_name" text NOT NULL, "file_mime_type" text NOT NULL, "file_size" integer NOT NULL DEFAULT 0, "created_by_user_id" text, "change_summary" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE IF NOT EXISTS "document_asset_audit_logs" ("id" text PRIMARY KEY, "document_asset_id" text NOT NULL REFERENCES "document_assets"("id") ON DELETE CASCADE, "company_id" text NOT NULL, "actor_user_id" text, "actor_email" text, "action" text NOT NULL, "before_json" jsonb, "after_json" jsonb, "ip_address" text, "user_agent" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE IF NOT EXISTS "contracts" ("id" text PRIMARY KEY, "company_id" text NOT NULL, "title" text NOT NULL, "contractor_id" text, "approved_proposal_contractor_user_id" text, "status" text NOT NULL DEFAULT 'draft', "documenso_document_id" text, "storage_key" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE IF NOT EXISTS "contract_signers" ("id" text PRIMARY KEY, "contract_id" text NOT NULL, "company_id" text NOT NULL, "contractor_id" text, "user_id" text, "email" text NOT NULL, "name" text, "signer_role" text NOT NULL DEFAULT 'signer', "signer_type" text NOT NULL, "is_required" boolean NOT NULL DEFAULT true, "is_delegated" boolean NOT NULL DEFAULT false, "delegated_by_user_id" text, "replaces_signer_id" text, "signing_order" integer NOT NULL DEFAULT 1, "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','sent','viewed','signed','declined','expired','replaced')), "documenso_recipient_id" text, "signing_token_hash" text, "signing_token_expires_at" timestamp with time zone, "signed_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL);

CREATE TABLE IF NOT EXISTS "contract_audit_logs" ("id" text PRIMARY KEY, "contract_id" text NOT NULL, "company_id" text NOT NULL, "actor_user_id" text, "actor_email" text, "action" text NOT NULL, "before_json" jsonb, "after_json" jsonb, "created_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE IF NOT EXISTS "documenso_webhook_events" ("id" text PRIMARY KEY, "event_id" text NOT NULL UNIQUE, "contract_id" text, "documenso_document_id" text, "event_type" text NOT NULL, "payload" jsonb, "processed_at" timestamp with time zone DEFAULT now() NOT NULL);
