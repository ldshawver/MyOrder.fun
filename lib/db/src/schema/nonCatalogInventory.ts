import { pgTable, serial, integer, text, numeric, boolean, timestamp, unique, foreignKey } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { inventoryLocationsTable } from "./shifts";

export const nonCatalogInventorySectionsTable = pgTable("non_catalog_inventory_sections", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  name: text("name").notNull(), displayOrder: integer("display_order").notNull().default(0), isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ tenantName: unique("non_catalog_sections_tenant_name").on(t.tenantId, t.name) }));

export const nonCatalogInventoryItemsTable = pgTable("non_catalog_inventory_items", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id), sectionId: integer("section_id").references(() => nonCatalogInventorySectionsTable.id),
  name: text("name").notNull(), description: text("description"), sku: text("sku"), barcode: text("barcode"), unitOfMeasure: text("unit_of_measure").notNull().default("each"),
  parLevel: numeric("par_level", { precision: 10, scale: 3 }).notNull().default("0"), moq: numeric("moq", { precision: 10, scale: 3 }).notNull().default("0"), preferredReorderQuantity: numeric("preferred_reorder_quantity", { precision: 10, scale: 3 }).notNull().default("0"),
  unitCost: numeric("unit_cost", { precision: 10, scale: 2 }), supplier: text("supplier"), supplierSku: text("supplier_sku"), notes: text("notes"), imageUrl: text("image_url"), isActive: boolean("is_active").notNull().default(true),
  createdByUserId: integer("created_by_user_id"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ tenantName: unique("non_catalog_items_tenant_name").on(t.tenantId, t.name), sectionTenant: foreignKey({ columns: [t.tenantId, t.sectionId], foreignColumns: [nonCatalogInventorySectionsTable.tenantId, nonCatalogInventorySectionsTable.id] }) }));

export const nonCatalogInventoryBalancesTable = pgTable("non_catalog_inventory_balances", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id), itemId: integer("item_id").notNull().references(() => nonCatalogInventoryItemsTable.id), locationId: integer("location_id").notNull().references(() => inventoryLocationsTable.id), quantityOnHand: numeric("quantity_on_hand", { precision: 10, scale: 3 }).notNull().default("0"), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniqueLocation: unique("non_catalog_balances_tenant_item_location").on(t.tenantId, t.itemId, t.locationId), tenantItem: foreignKey({ columns: [t.tenantId, t.itemId], foreignColumns: [nonCatalogInventoryItemsTable.tenantId, nonCatalogInventoryItemsTable.id] }), tenantLocation: foreignKey({ columns: [t.tenantId, t.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }) }));
