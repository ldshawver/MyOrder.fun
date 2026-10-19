ALTER TABLE catalogue_options
  ADD COLUMN option_values jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE catalogue_options
  ADD CONSTRAINT catalogue_options_option_values_object
  CHECK (jsonb_typeof(option_values) = 'object');

DO $$
BEGIN
  IF EXISTS (
    SELECT co.tenant_id, co.product_id, lower(btrim(co.label))
    FROM catalogue_options co
    WHERE (SELECT count(*) FROM catalogue_options siblings
      WHERE siblings.tenant_id=co.tenant_id AND siblings.product_id=co.product_id) > 1
    GROUP BY co.tenant_id, co.product_id, lower(btrim(co.label))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate legacy option labels require controlled reconciliation before variant support';
  END IF;
END $$;
UPDATE catalogue_options co
SET option_values = jsonb_build_object('Option', co.label)
WHERE (SELECT count(*) FROM catalogue_options siblings
  WHERE siblings.tenant_id=co.tenant_id AND siblings.product_id=co.product_id) > 1;

ALTER TABLE catalogue_options
  ADD CONSTRAINT catalogue_options_product_values_unique
  UNIQUE (tenant_id, product_id, option_values);

ALTER TABLE catalog_items ADD COLUMN barcode text;
ALTER TABLE order_items ADD COLUMN variant_snapshot jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT tenant_id, lower(btrim(sku))
    FROM catalog_items
    WHERE sku IS NOT NULL AND btrim(sku) <> ''
    GROUP BY tenant_id, lower(btrim(sku))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate tenant catalogue SKUs require controlled reconciliation before variant support';
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (
    SELECT tenant_id, woo_product_id, woo_variation_id FROM catalog_items
    WHERE woo_product_id IS NOT NULL AND woo_variation_id IS NOT NULL
    GROUP BY tenant_id, woo_product_id, woo_variation_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate Woo variation identities require controlled reconciliation before variant support';
  END IF;
END $$;
CREATE UNIQUE INDEX catalog_items_tenant_sku_ci_unique
  ON catalog_items (tenant_id, lower(btrim(sku)))
  WHERE sku IS NOT NULL AND btrim(sku) <> '';

CREATE UNIQUE INDEX catalog_items_tenant_woo_variation_unique
  ON catalog_items (tenant_id, woo_product_id, woo_variation_id)
  WHERE woo_product_id IS NOT NULL AND woo_variation_id IS NOT NULL;
