import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const catalogItemsTable = pgTable("catalog_items", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  // Legacy generic fields (kept for backward compat)
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  sku: text("sku"),
  // Internal/source-facing fields used by operations, custody, imports, and
  // supplier reconciliation. These must never be required for checkout copy.
  internalName: text("internal_name"),
  internalDescription: text("internal_description"),
  internalCategory: text("internal_category"),
  supplierName: text("supplier_name"),
  supplierCategory: text("supplier_category"),
  backendInventoryNotes: text("backend_inventory_notes"),
  vendorSku: text("vendor_sku"),
  sourceInventoryId: text("source_inventory_id"),
  costBasis: numeric("cost_basis", { precision: 10, scale: 2 }),
  inventoryTrackingData: jsonb("inventory_tracking_data").default({}),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  compareAtPrice: numeric("compare_at_price", { precision: 10, scale: 2 }),
  stockQuantity: numeric("stock_quantity", { precision: 10, scale: 2 }).default("0"),
  isAvailable: boolean("is_available").notNull().default(true),
  imageUrl: text("image_url"),
  tags: text("tags").array().default([]),
  metadata: jsonb("metadata").default({}),
  // Dual-brand pricing
  regularPrice: numeric("regular_price", { precision: 10, scale: 2 }),
  homiePrice: numeric("homie_price", { precision: 10, scale: 2 }),
  // Alavont-facing fields (what customers see in the secure app)
  alavontName: text("alavont_name"),
  alavontDescription: text("alavont_description"),
  alavontCategory: text("alavont_category"),
  alavontImageUrl: text("alavont_image_url"),
  alavontInStock: boolean("alavont_in_stock").notNull().default(true),
  alavontIsUpsell: boolean("alavont_is_upsell").notNull().default(false),
  alavontIsSample: boolean("alavont_is_sample").notNull().default(false),
  alavontId: text("alavont_id"),
  alavontCreatedDate: text("alavont_created_date"),
  alavontUpdatedDate: text("alavont_updated_date"),
  alavontCreatedById: text("alavont_created_by_id"),
  alavontCreatedBy: text("alavont_created_by"),
  // Lucifer Cruz-facing fields (what the payment merchant sees)
  luciferCruzName: text("lucifer_cruz_name"),
  luciferCruzImageUrl: text("lucifer_cruz_image_url"),
  luciferCruzDescription: text("lucifer_cruz_description"),
  luciferCruzCategory: text("lucifer_cruz_category"),
  // Customer-facing converted checkout presentation. Admins can override
  // these fields without changing the operational/source inventory record.
  displayName: text("display_name"),
  displayDescription: text("display_description"),
  displayCategory: text("display_category"),
  displayImage: text("display_image"),
  merchantBrandName: text("merchant_brand_name"),
  marketingCopy: text("marketing_copy"),
  customerSafeName: text("customer_safe_name"),
  customerSafeDescription: text("customer_safe_description"),
  upsellCopy: text("upsell_copy"),
  promoBadges: text("promo_badges").array().default([]),
  // Merchant routing / dual-brand processing
  merchantProcessingMode: text("merchant_processing_mode").default("mapped_lucifer"),
  merchantProductSource: text("merchant_product_source").default("local_mapped"),
  isWooManaged: boolean("is_woo_managed").notNull().default(false),
  isLocalAlavont: boolean("is_local_alavont").notNull().default(true),
  wooProductId: text("woo_product_id"),
  wooVariationId: text("woo_variation_id"),
  // Print/queue names
  receiptName: text("receipt_name"),
  labelName: text("label_name"),
  labName: text("lab_name"),
  // Inventory tracking unit
  stockUnit: text("stock_unit").default("#"),
  // Par level — minimum desired stock; drives restock slip generation
  parLevel: numeric("par_level", { precision: 10, scale: 2 }).default("0"),
  // ── Task #10: 14-column menu import spec ──
  externalMenuId: text("external_menu_id"),
  inventoryAmount: numeric("inventory_amount", { precision: 10, scale: 2 }),
  unitMeasurement: text("unit_measurement"),
  merchantName: text("merchant_name"),
  merchantImage: text("merchant_image"),
  merchantDescription: text("merchant_description"),
  merchantCategory: text("merchant_category"),
  // Merchant-side SKU on the Lucifer Cruz catalog. For Alavont-brand items the
  // server-side checkout normalizer requires this to be non-empty so the LC
  // mapping resolves before any payment intent is created.
  merchantSku: text("merchant_sku"),
  // Discriminator for which catalog/brand surface the item lives on.
  // - "alavont": customer-facing Alavont item that MUST be converted to a
  //   Lucifer Cruz merchant line by the normalizer before payment.
  // - "lucifer_cruz": item already on the LC merchant catalog (no rewrite).
  merchantBrand: text("merchant_brand").notNull().default("alavont"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type CatalogItem = typeof catalogItemsTable.$inferSelect;
export type InsertCatalogItem = typeof catalogItemsTable.$inferInsert;
