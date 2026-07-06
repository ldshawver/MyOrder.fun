# Catalog schema compatibility report

Date: 2026-07-05

## A. Production catalog_items schema

No live `DATABASE_URL`/`DB_URL` is present in this workspace, so the local audit cannot run `information_schema.columns` against production directly. The production evidence supplied by operations is treated as authoritative for the incident: `safe_name`, `safe_description`, `safe_category`, and `safe_image_url` do not exist in PostgreSQL. The checked-in VPS schema snapshot also has no `safe_*` columns on `catalog_items`.

`deploy/vps-database.sql` defines these `catalog_items` columns:

- `id`, `tenant_id`
- `name`, `description`, `category`, `sku`
- `price`, `compare_at_price`, `stock_quantity`, `is_available`, `image_url`
- `tags`, `metadata`, `created_at`, `updated_at`
- `regular_price`, `homie_price`
- `alavont_name`, `alavont_description`, `alavont_category`, `alavont_image_url`, `alavont_in_stock`, `alavont_is_upsell`, `alavont_is_sample`, `alavont_id`, `alavont_created_date`, `alavont_updated_date`, `alavont_created_by_id`, `alavont_created_by`
- `lucifer_cruz_name`, `lucifer_cruz_image_url`, `lucifer_cruz_description`
- `receipt_name`, `label_name`, `lab_name`, `stock_unit`

## B. Current Drizzle schema

`lib/db/src/schema/catalog.ts` now uses the production-compatible model:

- Product/inventory identity: `id` / `tenantId` / source product fields.
- Customer-safe presentation fields: `customerSafeName` (`customer_safe_name`) and `customerSafeDescription` (`customer_safe_description`).
- Merchant/category/image presentation fields: `luciferCruzCategory`, `luciferCruzImageUrl`, `merchantCategory`, `merchantImage`, `displayCategory`, and `displayImage` where migrations create them.
- Removed abandoned Drizzle fields: `safeName`, `safeDescription`, `safeCategory`, `safeImageUrl`.

## C. Migrations affecting catalog_items

Catalog-affecting migrations found under `lib/db/drizzle`:

- `0000_dual_brand_columns.sql`: adds Alavont fields, Lucifer Cruz fields, Woo/local flags, Woo ids, merchant processing/source, and `receipt_name`.
- `0003_par_level.sql`: adds `par_level`.
- `0008_menu_import_columns.sql`: adds `external_menu_id`, `inventory_amount`, `unit_measurement`, `merchant_name`, `merchant_image`, `merchant_description`, `merchant_category`.
- `0010_merchant_brand_sku.sql`: adds `merchant_sku`, `merchant_brand`, and backfills merchant brand/SKU values.
- `0012_product_conversion_fields.sql`: adds internal/source fields, display fields, `merchant_brand_name`, `marketing_copy`, `customer_safe_name`, `customer_safe_description`, `upsell_copy`, and `promo_badges`.
- `0017_csr_inventory_catalog_repair.sql`: updates catalog rows for CSR inventory repair.
- `0018_catalog_notifications_banners.sql`: alters catalog notification/banner-related fields.
- `0026_repair_duplicate_catalog_items.sql`: duplicate repair archive/mapping and reference movement involving catalog rows.

Removed the abandoned standalone migration `lib/db/migrations/202606250001_catalog_canonical_safe_fields.sql` because it created `safe_name`, `safe_description`, `safe_category`, and `safe_image_url`, which do not exist in production and are not part of the canonical model.

## D. Field reference audit

Audited references to:

- `customer_safe_name`
- `customer_safe_description`
- `merchant_category`
- `lucifer_cruz_category`
- `display_category`
- `merchant_image`
- `display_image`
- `safe_name`
- `safe_description`
- `safe_category`
- `safe_image_url`

Runtime code now uses no `safe_*` database columns. The generated field reference audit is in `docs/catalog-field-reference-audit.md`. Non-test API/server/schema/script code no longer selects, inserts, updates, adds, or aliases `safe_name`, `safe_description`, `safe_category`, or `safe_image_url`.

## E. Canonical field model

Canonical model going forward:

1. Inventory identity: `catalog_items.id` only.
2. Inventory balances identity: `inventory_balances.product_id = catalog_items.id` only.
3. Customer-safe product name: `catalog_items.customer_safe_name`.
4. Customer-safe product description: `catalog_items.customer_safe_description`.
5. Customer-safe category: `catalog_items.lucifer_cruz_category` with runtime fallback to `merchant_category` / `category` for display only.
6. Customer-safe image: `catalog_items.lucifer_cruz_image_url` with runtime fallback to `merchant_image` / `display_image` / `image_url` for display only.
7. Abandoned/non-production DB names are forbidden in runtime code: `safe_name`, `safe_description`, `safe_category`, `safe_image_url`.
8. Identity rule: inventory, checkout, order, PAR, import matching, and duplicate repair identity use only `catalog_items.id`, `inventory_balances.product_id`, SKU, `merchant_sku`, or `alavont_id`; customer/safe/merchant/display text fields are labels only and are forbidden as keys.

## F. Runtime alignment completed

- Drizzle no longer declares `safe_*` columns.
- Runtime schema preparation no longer creates `safe_*` columns.
- Import maps Safe CSV headers into `customer_safe_name`, `customer_safe_description`, `lucifer_cruz_category`, and `lucifer_cruz_image_url`.
- Checkout conversion reads `customerSafeName` / `customerSafeDescription` and no longer reads `safeName` / `safeDescription` / `safeCategory` / `safeImageUrl`.
- Inventory/PAR exposes `customerSafeName` as secondary presentation data and never uses it as product identity.
- Duplicate repair dry-run/confirm script matches only SKU or `merchant_sku` / `alavont_id`, not names or customer-safe text fields.
- Import matching is permanently disabled for product names, customer-safe names, merchant names, display names, and category/image fields.
- Runtime identity guard logs stack traces and throws in development/staging/test if an inventory lookup receives a non-integer catalog id.
- Script command compatibility added: `pnpm --filter @workspace/scripts repair-duplicate-safe-products`.

## Compatibility matrix

| Layer | Status | Notes |
| --- | --- | --- |
| Production DB | Compatible | Operations confirmed no `safe_*`; checked-in VPS schema also has no `safe_*`. |
| Migration state | Compatible | No active migration creates `safe_*`; `0012` creates `customer_safe_name` and `customer_safe_description`; the abandoned `202606250001_catalog_canonical_safe_fields.sql` migration has been removed. |
| Drizzle | Compatible | Removed abandoned `safe*` fields from `catalogItemsTable`. |
| Runtime code | Compatible | Non-test runtime code no longer references non-production `safe_*` catalog columns; inventory lookup helpers assert `catalog_items.id` identity. |
