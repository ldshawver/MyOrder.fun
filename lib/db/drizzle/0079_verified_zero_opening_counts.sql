-- Preserve the non-zero movement invariant except for an explicitly verified
-- opening count of zero. This event establishes that a previously missing
-- location balance was physically counted; it must not change stock or value.
ALTER TABLE "inventory_movements"
  DROP CONSTRAINT "inventory_movements_quantity_nonzero";

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_quantity_nonzero" CHECK (
    "quantity_delta" <> 0
    OR (
      "quantity_delta" = 0
      AND "movement_type" = 'correction'
      AND "source_type" = 'verified_opening_count'
      AND "reason_code" = 'opening_count'
      AND "pre_quantity" = 0
      AND "post_quantity" = 0
      AND "destination_location_id" IS NULL
      AND "unit_cost" IS NULL
      AND "extended_cost" = 0
    )
  );
