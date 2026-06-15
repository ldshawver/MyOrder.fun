CREATE TABLE IF NOT EXISTS "role_permissions" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer REFERENCES "tenants"("id") ON DELETE cascade,
  "role" text NOT NULL,
  "permission" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_tenant_role_permission_idx" ON "role_permissions" ("tenant_id", "role", "permission");

CREATE TABLE IF NOT EXISTS "permission_audit_logs" (
  "id" serial PRIMARY KEY,
  "actor_user_id" integer REFERENCES "users"("id"),
  "tenant_id" integer REFERENCES "tenants"("id") ON DELETE set null,
  "action" text NOT NULL,
  "target_role" text NOT NULL,
  "permission" text,
  "old_value" boolean,
  "new_value" boolean,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

UPDATE "users" SET "role" = CASE
  WHEN lower(replace(replace(trim("role"), '-', '_'), ' ', '_')) IN ('customer', 'normal_user') THEN 'user'
  WHEN lower(replace(replace(trim("role"), '-', '_'), ' ', '_')) IN ('customer_service_rep', 'customer_service_representative', 'customer_service', 'customer_service_specialist', 'customer_success', 'service_rep', 'csr', 'qsr', 'business_sitter', 'sales_rep', 'lab_tech', 'lab_technician') THEN 'csr'
  WHEN lower(replace(replace(trim("role"), '-', '_'), ' ', '_')) = 'supervisor' THEN 'supervisor'
  WHEN lower(replace(replace(trim("role"), '-', '_'), ' ', '_')) IN ('manager', 'tenant_admin', 'admin') THEN 'admin'
  WHEN lower(replace(replace(trim("role"), '-', '_'), ' ', '_')) IN ('super_admin', 'platform_admin', 'global_admin') THEN 'global_admin'
  ELSE 'user'
END;
