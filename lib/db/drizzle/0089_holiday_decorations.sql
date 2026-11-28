CREATE TABLE holiday_decorations (
  tenant_id integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT holiday_decorations_version_positive CHECK (version > 0)
);
