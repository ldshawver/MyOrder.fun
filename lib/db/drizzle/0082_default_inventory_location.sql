ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS default_inventory_location_id integer;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_settings_default_inventory_location_fk' AND conrelid = 'tenant_settings'::regclass) THEN
    ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_default_inventory_location_fk
      FOREIGN KEY (tenant_id, default_inventory_location_id)
      REFERENCES inventory_locations(tenant_id, id);
  END IF;
END $$;
