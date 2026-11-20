-- Forward-only guest ownership support for staff-assisted Speed Order.
-- Existing authenticated orders retain customer_id and are not backfilled.
CREATE TABLE "guest_order_identities" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "created_by_user_id" integer NOT NULL REFERENCES "users"("id"),
  "display_name" text NOT NULL,
  "phone" text,
  "delivery_address" text,
  "tracking_token_hash" text NOT NULL UNIQUE,
  "tracking_expires_at" timestamptz NOT NULL,
  "tracking_revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "guest_order_identities_tenant_id_id_unique" UNIQUE ("tenant_id", "id")
);
CREATE INDEX "guest_order_identities_tracking_lookup_idx"
  ON "guest_order_identities" ("tracking_token_hash", "tracking_expires_at");

CREATE TABLE "guest_checkout_sessions" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "guest_identity_id" integer NOT NULL REFERENCES "guest_order_identities"("id"),
  "staff_actor_user_id" integer NOT NULL REFERENCES "users"("id"),
  "capability_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "consumed_at" timestamptz,
  "idempotency_key" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "guest_checkout_sessions_tenant_id_id_unique" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "guest_checkout_sessions_actor_idempotency_unique" UNIQUE ("tenant_id", "staff_actor_user_id", "idempotency_key"),
  CONSTRAINT "guest_checkout_sessions_guest_tenant_fk" FOREIGN KEY ("tenant_id", "guest_identity_id") REFERENCES "guest_order_identities"("tenant_id", "id")
);
CREATE INDEX "guest_checkout_sessions_capability_lookup_idx" ON "guest_checkout_sessions" ("capability_hash", "expires_at");

ALTER TABLE "orders" ADD COLUMN "guest_identity_id" integer;
ALTER TABLE "orders" ALTER COLUMN "customer_id" DROP NOT NULL;
ALTER TABLE "orders" ADD CONSTRAINT "orders_guest_identity_id_guest_order_identities_id_fk"
  FOREIGN KEY ("guest_identity_id") REFERENCES "guest_order_identities"("id");
ALTER TABLE "orders" ADD CONSTRAINT "orders_guest_identity_tenant_fk"
  FOREIGN KEY ("tenant_id", "guest_identity_id") REFERENCES "guest_order_identities"("tenant_id", "id");
ALTER TABLE "orders" ADD CONSTRAINT "orders_owner_exactly_one_check"
  CHECK (("customer_id" IS NOT NULL) <> ("guest_identity_id" IS NOT NULL));
CREATE UNIQUE INDEX "orders_guest_identity_unique" ON "orders" ("guest_identity_id") WHERE "guest_identity_id" IS NOT NULL;
CREATE INDEX "orders_guest_identity_tenant_idx" ON "orders" ("tenant_id", "guest_identity_id");
