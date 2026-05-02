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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type CatalogItem = typeof catalogItemsTable.$inferSelect;
export type InsertCatalogItem = typeof catalogItemsTable.$inferInsert;
