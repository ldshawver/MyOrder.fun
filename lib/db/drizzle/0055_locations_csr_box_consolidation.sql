-- Slice 4: reconcile legacy CSR boxes into canonical inventory locations.
-- Forward-only, idempotent, and intentionally retains csr_boxes for compatibility.
INSERT INTO inventory_locations (tenant_id, type, csr_box_id, name, is_active, display_order)
SELECT b.tenant_id, 'csr_box', b.id, b.label, b.is_active, b.display_order
FROM csr_boxes b
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_locations l
  WHERE l.tenant_id = b.tenant_id
    AND l.type = 'csr_box'
    AND l.csr_box_id = b.id
);

CREATE INDEX IF NOT EXISTS inventory_locations_tenant_type_active_idx
  ON inventory_locations (tenant_id, type, is_active);
CREATE INDEX IF NOT EXISTS inventory_locations_tenant_csr_box_idx
  ON inventory_locations (tenant_id, csr_box_id)
  WHERE csr_box_id IS NOT NULL;
