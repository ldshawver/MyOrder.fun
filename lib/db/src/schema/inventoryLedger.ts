import { sql } from "drizzle-orm";
import { check, foreignKey, integer, numeric, pgTable, serial, smallint, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { catalogItemsTable } from "./catalog";
import { nonCatalogInventoryItemsTable } from "./nonCatalogInventory";
import { orderItemsTable, ordersTable } from "./orders";
import { inventoryLocationsTable } from "./shifts";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const inventoryReceiptsTable = pgTable("inventory_receipts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  productId: integer("product_id").notNull().references(() => catalogItemsTable.id),
  locationId: integer("location_id").notNull().references(() => inventoryLocationsTable.id),
  quantityReceived: numeric("quantity_received", { precision: 10, scale: 3 }).notNull(),
  quantityBefore: numeric("quantity_before", { precision: 10, scale: 3 }).notNull(),
  quantityAfter: numeric("quantity_after", { precision: 10, scale: 3 }).notNull(),
  reason: text("reason"), reference: text("reference"), receivedByUserId: integer("received_by_user_id").notNull().references(() => usersTable.id),
  idempotencyKey: text("idempotency_key").notNull(), actualUnitCost: numeric("actual_unit_cost", { precision: 24, scale: 12 }),
  supplierReference: text("supplier_reference"), receivedAt: timestamp("received_at", { withTimezone: true }), movementId: integer("movement_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantProduct: foreignKey({ columns: [t.tenantId, t.productId], foreignColumns: [catalogItemsTable.tenantId, catalogItemsTable.id] }),
  tenantLocation: foreignKey({ columns: [t.tenantId, t.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }),
}));

export const inventoryValuationStatesTable = pgTable("inventory_valuation_states", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  inventoryEntityType: text("inventory_entity_type").notNull(), catalogItemId: integer("catalog_item_id"), nonCatalogItemId: integer("non_catalog_item_id"),
  costStatus: text("cost_status").notNull().default("known"), knownQuantity: numeric("known_quantity", { precision: 24, scale: 12 }).notNull().default("0"),
  averageUnitCost: numeric("average_unit_cost", { precision: 24, scale: 12 }), inventoryValue: numeric("inventory_value", { precision: 24, scale: 12 }),
  lastPurchaseUnitCost: numeric("last_purchase_unit_cost", { precision: 24, scale: 12 }), lastPurchaseAt: timestamp("last_purchase_at", { withTimezone: true }), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  entity: check("inventory_valuation_states_entity_type_check", sql`(${t.inventoryEntityType} = 'catalog' AND ${t.catalogItemId} IS NOT NULL AND ${t.nonCatalogItemId} IS NULL) OR (${t.inventoryEntityType} = 'non_catalog' AND ${t.catalogItemId} IS NULL AND ${t.nonCatalogItemId} IS NOT NULL)`),
  catalogUnique: uniqueIndex("inventory_valuation_states_catalog_unique").on(t.tenantId, t.catalogItemId).where(sql`${t.catalogItemId} IS NOT NULL`),
  nonCatalogUnique: uniqueIndex("inventory_valuation_states_non_catalog_unique").on(t.tenantId, t.nonCatalogItemId).where(sql`${t.nonCatalogItemId} IS NOT NULL`),
}));

export const inventoryMovementsTable = pgTable("inventory_movements", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  inventoryEntityType: text("inventory_entity_type").notNull(), catalogItemId: integer("catalog_item_id"), nonCatalogItemId: integer("non_catalog_item_id"),
  locationId: integer("location_id").notNull().references(() => inventoryLocationsTable.id), destinationLocationId: integer("destination_location_id").references(() => inventoryLocationsTable.id),
  movementType: text("movement_type").notNull(), quantityDelta: numeric("quantity_delta", { precision: 24, scale: 12 }).notNull(), unitOfMeasure: text("unit_of_measure").notNull(),
  unitCost: numeric("unit_cost", { precision: 24, scale: 12 }), extendedCost: numeric("extended_cost", { precision: 24, scale: 12 }),
  preQuantity: numeric("pre_quantity", { precision: 24, scale: 12 }).notNull(), postQuantity: numeric("post_quantity", { precision: 24, scale: 12 }).notNull(),
  preAverageUnitCost: numeric("pre_average_unit_cost", { precision: 24, scale: 12 }), postAverageUnitCost: numeric("post_average_unit_cost", { precision: 24, scale: 12 }),
  sourceType: text("source_type").notNull(), sourceId: text("source_id"), orderId: integer("order_id").references(() => ordersTable.id), orderItemId: integer("order_item_id").references(() => orderItemsTable.id), receiptId: integer("receipt_id"),
  supplierReference: text("supplier_reference"), reasonCode: text("reason_code"), reasonText: text("reason_text"), idempotencyKey: text("idempotency_key").notNull(), movementIndex: smallint("movement_index").notNull().default(0), correlationId: text("correlation_id").notNull(), actorUserId: integer("actor_user_id").notNull().references(() => usersTable.id), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  entity: check("inventory_movements_entity_type_check", sql`(${t.inventoryEntityType} = 'catalog' AND ${t.catalogItemId} IS NOT NULL AND ${t.nonCatalogItemId} IS NULL) OR (${t.inventoryEntityType} = 'non_catalog' AND ${t.catalogItemId} IS NULL AND ${t.nonCatalogItemId} IS NOT NULL)`),
  idempotency: uniqueIndex("inventory_movements_tenant_idempotency_index_unique").on(t.tenantId, t.idempotencyKey, t.movementIndex),
}));
