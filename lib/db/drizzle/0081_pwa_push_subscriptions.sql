-- Formal journal entry for durable browser subscriptions used by order push.
-- Runtime setup remains idempotent for installs that already ran the legacy DDL.
CREATE TABLE IF NOT EXISTS pwa_push_subscriptions (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id integer REFERENCES tenants(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  endpoint text NOT NULL UNIQUE,
  subscription jsonb NOT NULL,
  user_agent text,
  platform text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pwa_push_subscriptions_user_active_idx
  ON pwa_push_subscriptions (user_id, is_active);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pwa_push_subscriptions_tenant_active_idx
  ON pwa_push_subscriptions (tenant_id, is_active);
