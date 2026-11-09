import { sql } from "drizzle-orm";
import { quantityText, quantityUnits } from "./exactQuantity";

/**
 * A special is a catalogue option with a component list.
 * The customer pays that option's sale price (including the employee price).
 * Stock is taken from each component's own inventory, never from the special's own balance.
 * The table is created on the request path. Production does not run a migrate container for this.
 */
const MAX_COMPONENTS = 12;
const MAX_COMPONENT_UNITS = 1000n * 1_000_000n;

export class SpecialComponentInputError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) {
    super(message);
    this.name = "SpecialComponentInputError";
    this.status = status;
  }
}

export class SpecialComponentSnapshotError extends Error {
  constructor() {
    super("Stored special components are incomplete");
    this.name = "SpecialComponentSnapshotError";
  }
}

export type SpecialLocationEvaluation = "PER_LOCATION" | "COMBINED_LOCATIONS";

export type ComponentStock = {
  specialCatalogItemId: number;
  catalogItemId: number;
  productName: string | null;
  label: string | null;
  quantity: string;
  consumptionQuantity: string | null;
  inventoryCatalogItemId: number | null;
  inventoryItemId: number | null;
  locationEvaluation: string | null;
  balanceRowCount: number;
  availableQuantity: string | null;
  maxLocationAvailable: string | null;
  active: boolean;
  productActive: boolean;
  isAvailable: boolean;
  isWooManaged: boolean;
  complianceHold: boolean;
  archived: boolean;
  visible: boolean;
};

export type CheckoutComponent = {
  catalogItemId: number;
  inventoryCatalogItemId: number;
  inventoryItemId: number;
  name: string;
  quantity: string;
  physicalQuantity: string;
  locationEvaluation: SpecialLocationEvaluation;
};

export type SpecialAvailability = {
  orderable: boolean;
  inventoryStatus: "ready" | "missing_identity" | "missing_balance";
  availableQuantity: string | null;
};

export type ReservationDemand = {
  inventoryCatalogItemId: number;
  catalogItemId: number;
  physicalQuantity: string;
  locationEvaluation: SpecialLocationEvaluation;
  name: string;
};

type SqlExecutor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

let specialComponentsSchema: Promise<void> | null = null;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

function asNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

/** Missing visibility stays visible. Only an explicit false hides the component. */
function asDefaultVisible(value: unknown): boolean {
  return value !== false && value !== "f" && value !== "false";
}

/** Multiply two six-decimal quantities and keep the physical scale. */
export function scaledQuantityProduct(left: string, right: string): bigint {
  const scale = 1_000_000n;
  return (quantityUnits(left) * quantityUnits(right) + scale / 2n) / scale;
}

export function formatRetailQuantity(quantity: string): string {
  const units = quantityUnits(quantity);
  if (units % 1_000_000n === 0n) return String(units / 1_000_000n);
  return quantityText(units).replace(/0+$/, "").replace(/\.$/, "");
}

export function specialIncludesNote(components: Array<{ name: string; quantity: string }>): string {
  return `Includes ${components.map(component => `${component.quantity} ${component.name}`).join(", ")}`;
}

export function ensureSpecialComponentsTable(): Promise<void> {
  if (!specialComponentsSchema) {
    specialComponentsSchema = createSpecialComponentsTable().catch(error => {
      specialComponentsSchema = null;
      throw error;
    });
  }
  return specialComponentsSchema;
}

async function database() {
  const { db } = await import("@workspace/db");
  return db;
}

async function createSpecialComponentsTable(): Promise<void> {
  const db = await database();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS catalogue_special_components (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL REFERENCES tenants(id),
      special_catalog_item_id integer NOT NULL,
      component_catalog_item_id integer NOT NULL,
      quantity numeric(20, 6) NOT NULL CHECK (quantity > 0),
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, special_catalog_item_id, component_catalog_item_id),
      FOREIGN KEY (tenant_id, special_catalog_item_id) REFERENCES catalog_items (tenant_id, id),
      FOREIGN KEY (tenant_id, component_catalog_item_id) REFERENCES catalog_items (tenant_id, id),
      CHECK (special_catalog_item_id <> component_catalog_item_id)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS catalogue_special_components_special_idx
    ON catalogue_special_components (tenant_id, special_catalog_item_id, sort_order, id)
  `);
}

export async function loadSpecialComponentRows(executor: SqlExecutor, tenantId: number, specialCatalogItemIds?: number[]): Promise<ComponentStock[]> {
  await ensureSpecialComponentsTable();
  if (specialCatalogItemIds && specialCatalogItemIds.length === 0) return [];
  const filter = specialCatalogItemIds
    ? sql`AND sc.special_catalog_item_id = ANY(ARRAY[${sql.join(specialCatalogItemIds.map(id => sql`${id}`), sql`, `)}]::int[])`
    : sql``;
  return rowsOf<Record<string, unknown>>(await executor.execute(sql`
    WITH reserved_by_location AS (
      SELECT r.catalog_item_id, r.location_id, SUM(r.quantity)::numeric AS quantity
      FROM inventory_reservations r
      JOIN orders o ON o.id = r.order_id AND o.tenant_id = ${tenantId}
      WHERE r.status = 'reserved'
        AND (r.expires_at > now() OR EXISTS (
          SELECT 1 FROM payment_attempts p
          WHERE p.order_id = r.order_id AND p.tenant_id = ${tenantId}
            AND p.state IN ('creating','created','approved','capturing','reconciliation_required')
        ))
      GROUP BY r.catalog_item_id, r.location_id
    ), availability AS (
      SELECT ib.product_id,
        COUNT(*)::integer AS balance_row_count,
        SUM(GREATEST(ib.quantity_on_hand - COALESCE(r.quantity, 0), 0))::numeric AS available_quantity,
        MAX(GREATEST(ib.quantity_on_hand - COALESCE(r.quantity, 0), 0))::numeric AS max_location_available
      FROM inventory_balances ib
      JOIN inventory_locations il ON il.tenant_id = ib.tenant_id AND il.id = ib.location_id AND il.is_active = true
      LEFT JOIN reserved_by_location r ON r.catalog_item_id = ib.product_id AND r.location_id = ib.location_id
      WHERE ib.tenant_id = ${tenantId} AND ib.inventory_kind = 'sellable_catalog'
        AND ib.is_sellable = true AND ib.quarantined_at IS NULL
      GROUP BY ib.product_id
    )
    SELECT sc.special_catalog_item_id AS "specialCatalogItemId",
      sc.component_catalog_item_id AS "catalogItemId",
      cp.name AS "productName", co.label,
      sc.quantity::text AS quantity,
      co.consumption_quantity::text AS "consumptionQuantity",
      ii.catalog_item_id AS "inventoryCatalogItemId",
      ii.id AS "inventoryItemId",
      cp.location_evaluation AS "locationEvaluation",
      COALESCE(a.balance_row_count, 0)::integer AS "balanceRowCount",
      a.available_quantity::text AS "availableQuantity",
      a.max_location_available::text AS "maxLocationAvailable",
      COALESCE(co.active, false) AS active,
      COALESCE(cp.active, false) AS "productActive",
      COALESCE(ci.is_available, false) AS "isAvailable",
      COALESCE(ci.is_woo_managed, false) AS "isWooManaged",
      COALESCE(ci.metadata->>'complianceHold' = 'true', false) AS "complianceHold",
      COALESCE((ci.metadata->>'archived')::boolean, false) AS archived,
      COALESCE((ci.metadata->>'isVisible')::boolean, true) AS visible
    FROM catalogue_special_components sc
    LEFT JOIN catalogue_options co ON co.tenant_id = sc.tenant_id AND co.catalog_item_id = sc.component_catalog_item_id
    LEFT JOIN catalogue_products cp ON cp.tenant_id = co.tenant_id AND cp.id = co.product_id
    LEFT JOIN catalog_items ci ON ci.tenant_id = sc.tenant_id AND ci.id = sc.component_catalog_item_id
    LEFT JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
    LEFT JOIN availability a ON a.product_id = ii.catalog_item_id
    WHERE sc.tenant_id = ${tenantId}
      ${filter}
    ORDER BY sc.special_catalog_item_id, sc.sort_order, sc.id
  `)).map((row): ComponentStock => ({
    specialCatalogItemId: Number(row.specialCatalogItemId),
    catalogItemId: Number(row.catalogItemId),
    productName: row.productName == null ? null : String(row.productName),
    label: row.label == null ? null : String(row.label),
    quantity: String(row.quantity),
    consumptionQuantity: row.consumptionQuantity == null ? null : String(row.consumptionQuantity),
    inventoryCatalogItemId: asNumber(row.inventoryCatalogItemId),
    inventoryItemId: asNumber(row.inventoryItemId),
    locationEvaluation: row.locationEvaluation == null ? null : String(row.locationEvaluation),
    balanceRowCount: Number(row.balanceRowCount ?? 0),
    availableQuantity: row.availableQuantity == null ? null : String(row.availableQuantity),
    maxLocationAvailable: row.maxLocationAvailable == null ? null : String(row.maxLocationAvailable),
    active: asBoolean(row.active),
    productActive: asBoolean(row.productActive),
    isAvailable: asBoolean(row.isAvailable),
    isWooManaged: asBoolean(row.isWooManaged),
    complianceHold: asBoolean(row.complianceHold),
    archived: asBoolean(row.archived),
    visible: asDefaultVisible(row.visible),
  }));
}

export function groupSpecialStock(rows: ComponentStock[]): Map<number, ComponentStock[]> {
  const grouped = new Map<number, ComponentStock[]>();
  for (const row of rows) {
    const list = grouped.get(row.specialCatalogItemId) ?? [];
    list.push(row);
    grouped.set(row.specialCatalogItemId, list);
  }
  return grouped;
}

function componentName(row: Pick<ComponentStock, "productName" | "label">): string {
  const label = row.label?.trim() || "Item";
  const productName = row.productName?.trim() || "Item";
  return label === "Standard" ? productName : `${productName} — ${label}`;
}

function reservable(row: ComponentStock): boolean {
  return row.active && row.productActive && row.isAvailable && !row.isWooManaged && !row.complianceHold
    && !row.archived && row.visible && row.inventoryCatalogItemId != null && row.inventoryItemId != null
    && row.consumptionQuantity != null && (row.locationEvaluation === "PER_LOCATION" || row.locationEvaluation === "COMBINED_LOCATIONS")
    && row.catalogItemId !== row.specialCatalogItemId;
}

export function checkoutComponentFromStock(row: ComponentStock): CheckoutComponent | null {
  if (!reservable(row) || row.consumptionQuantity == null || row.inventoryCatalogItemId == null || row.inventoryItemId == null) return null;
  try {
    const physical = scaledQuantityProduct(row.consumptionQuantity, row.quantity);
    if (physical <= 0n) return null;
    return {
      catalogItemId: row.catalogItemId,
      inventoryCatalogItemId: row.inventoryCatalogItemId,
      inventoryItemId: row.inventoryItemId,
      name: componentName(row),
      quantity: quantityText(quantityUnits(row.quantity)),
      physicalQuantity: quantityText(physical),
      locationEvaluation: row.locationEvaluation as SpecialLocationEvaluation,
    };
  } catch {
    return null;
  }
}

export type LoadedSpecial = { incomplete: boolean; stock: ComponentStock[]; components: CheckoutComponent[] };

export async function loadCheckoutSpecialComponents(executor: SqlExecutor, tenantId: number, catalogItemIds: number[]): Promise<Map<number, LoadedSpecial>> {
  const grouped = groupSpecialStock(await loadSpecialComponentRows(executor, tenantId, [...new Set(catalogItemIds)]));
  const loaded = new Map<number, LoadedSpecial>();
  for (const [catalogItemId, stock] of grouped) {
    const components: CheckoutComponent[] = [];
    let incomplete = false;
    for (const row of stock) {
      const component = checkoutComponentFromStock(row);
      if (!component) incomplete = true;
      else components.push(component);
    }
    loaded.set(catalogItemId, { incomplete, stock, components });
  }
  return loaded;
}

function supplyUnits(row: ComponentStock, locationEvaluation: SpecialLocationEvaluation): bigint | null {
  if (row.balanceRowCount <= 0) return null;
  const text = locationEvaluation === "PER_LOCATION" ? row.maxLocationAvailable : row.availableQuantity;
  if (text == null) return null;
  try { return quantityUnits(text); } catch { return null; }
}

/** How many specials can be built. Demand that shares one inventory item is added together. */
export function specialsAvailable(components: ComponentStock[], lineQuantity = 1): SpecialAvailability {
  if (!components.length || !Number.isSafeInteger(lineQuantity) || lineQuantity <= 0) {
    return { orderable: false, inventoryStatus: "missing_identity", availableQuantity: null };
  }
  type Group = { requiredPerSpecial: bigint; supply: bigint | null; broken: "identity" | "balance" | null };
  const groups = new Map<number, Group>();
  for (const component of components) {
    const checkout = checkoutComponentFromStock(component);
    if (!checkout) {
      const missingIdentity = component.inventoryItemId == null || component.inventoryCatalogItemId == null;
      return { orderable: false, inventoryStatus: missingIdentity ? "missing_identity" : "missing_balance", availableQuantity: "0.000000" };
    }
    const locationEvaluation: SpecialLocationEvaluation = [...components]
      .filter(row => row.inventoryCatalogItemId === checkout.inventoryCatalogItemId)
      .some(row => row.locationEvaluation === "PER_LOCATION")
      ? "PER_LOCATION" : checkout.locationEvaluation;
    const required = quantityUnits(checkout.physicalQuantity);
    const supply = supplyUnits(component, locationEvaluation);
    const existing = groups.get(checkout.inventoryCatalogItemId);
    if (!existing) {
      groups.set(checkout.inventoryCatalogItemId, { requiredPerSpecial: required, supply, broken: supply == null ? "balance" : null });
    } else {
      existing.requiredPerSpecial += required;
      if (supply == null) existing.broken = "balance";
      else if (locationEvaluation === "PER_LOCATION" || existing.supply == null) existing.supply = supply;
    }
  }
  let specials: bigint | null = null;
  for (const group of groups.values()) {
    if (group.broken || group.supply == null || group.requiredPerSpecial <= 0n) {
      return { orderable: false, inventoryStatus: "missing_balance", availableQuantity: "0.000000" };
    }
    const count = group.supply / group.requiredPerSpecial;
    specials = specials == null || count < specials ? count : specials;
  }
  const available = specials ?? 0n;
  return {
    orderable: available >= BigInt(lineQuantity),
    inventoryStatus: "ready",
    availableQuantity: quantityText(available * 1_000_000n),
  };
}

export function groupSpecialReservationDemands(components: CheckoutComponent[], lineQuantity: number): ReservationDemand[] {
  if (!Number.isSafeInteger(lineQuantity) || lineQuantity <= 0) throw new Error("Invalid special quantity");
  const line = BigInt(lineQuantity);
  const groups = new Map<number, { units: bigint; locationEvaluation: SpecialLocationEvaluation; names: string[]; catalogItemId: number }>();
  for (const component of components) {
    const units = quantityUnits(component.physicalQuantity) * line;
    const existing = groups.get(component.inventoryCatalogItemId);
    if (!existing) {
      groups.set(component.inventoryCatalogItemId, {
        units, locationEvaluation: component.locationEvaluation, names: [component.name], catalogItemId: component.catalogItemId,
      });
    } else {
      existing.units += units;
      if (component.locationEvaluation === "PER_LOCATION") existing.locationEvaluation = "PER_LOCATION";
      existing.names.push(component.name);
    }
  }
  return [...groups.entries()].map(([inventoryCatalogItemId, group]) => ({
    inventoryCatalogItemId,
    catalogItemId: group.catalogItemId,
    physicalQuantity: quantityText(group.units),
    locationEvaluation: group.locationEvaluation,
    name: group.names.join(", "),
  }));
}

export function specialComponentSnapshot(components: CheckoutComponent[]) {
  return components.map(component => ({
    catalogItemId: component.catalogItemId,
    inventoryCatalogItemId: component.inventoryCatalogItemId,
    inventoryItemId: component.inventoryItemId,
    name: component.name,
    quantity: component.quantity,
    physicalQuantity: component.physicalQuantity,
    locationEvaluation: component.locationEvaluation,
  }));
}

export function readSpecialComponentSnapshot(snapshot: unknown): CheckoutComponent[] | null {
  if (!snapshot || typeof snapshot !== "object" || !Object.hasOwn(snapshot, "specialComponents")) return null;
  const raw = (snapshot as { specialComponents?: unknown }).specialComponents;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_COMPONENTS) throw new SpecialComponentSnapshotError();
  return raw.map(entry => {
    if (!entry || typeof entry !== "object") throw new SpecialComponentSnapshotError();
    const row = entry as Record<string, unknown>;
    const catalogItemId = asNumber(row.catalogItemId);
    const inventoryCatalogItemId = asNumber(row.inventoryCatalogItemId);
    const inventoryItemId = asNumber(row.inventoryItemId);
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const locationEvaluation = row.locationEvaluation === "PER_LOCATION" || row.locationEvaluation === "COMBINED_LOCATIONS"
      ? row.locationEvaluation : null;
    if (catalogItemId == null || inventoryCatalogItemId == null || inventoryItemId == null || !name || !locationEvaluation) {
      throw new SpecialComponentSnapshotError();
    }
    try {
      const quantity = quantityText(quantityUnits(String(row.quantity)));
      const physicalQuantity = quantityText(quantityUnits(String(row.physicalQuantity)));
      if (quantityUnits(quantity) <= 0n || quantityUnits(physicalQuantity) <= 0n) throw new SpecialComponentSnapshotError();
      return { catalogItemId, inventoryCatalogItemId, inventoryItemId, name, quantity, physicalQuantity, locationEvaluation };
    } catch (error) {
      if (error instanceof SpecialComponentSnapshotError) throw error;
      throw new SpecialComponentSnapshotError();
    }
  });
}

export function displaySpecialComponents(snapshot: unknown): Array<{ name: string; quantity: string }> {
  try {
    const components = readSpecialComponentSnapshot(snapshot);
    if (!components) return [];
    return components.map(component => ({ name: component.name, quantity: formatRetailQuantity(component.quantity) }));
  } catch {
    return [];
  }
}

export async function syncCatalogStockForInventoryItem(executor: SqlExecutor, tenantId: number, inventoryCatalogItemId: number): Promise<void> {
  await executor.execute(sql`
    UPDATE catalog_items SET
      stock_quantity = COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances
        WHERE tenant_id = ${tenantId} AND product_id = ${inventoryCatalogItemId}), 0),
      inventory_amount = COALESCE((SELECT SUM(quantity_on_hand) FROM inventory_balances
        WHERE tenant_id = ${tenantId} AND product_id = ${inventoryCatalogItemId}), 0)
    WHERE tenant_id = ${tenantId}
      AND id IN (
        SELECT co.catalog_item_id FROM catalogue_options co
        JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
        WHERE co.tenant_id = ${tenantId} AND ii.catalog_item_id = ${inventoryCatalogItemId}
        UNION SELECT ${inventoryCatalogItemId}
      )
  `);
}

type ComponentInput = { catalogItemId: number; quantity: string };

export async function replaceSpecialComponents(tenantId: number, optionId: number, input: ComponentInput[]): Promise<Array<{ catalogItemId: number; productName: string; label: string; quantity: string }>> {
  await ensureSpecialComponentsTable();
  if (input.length > MAX_COMPONENTS) throw new SpecialComponentInputError(400, "A special can include at most 12 products.");
  const seen = new Set<number>();
  const normalized = input.map(component => {
    if (seen.has(component.catalogItemId)) throw new SpecialComponentInputError(400, "Each component can only be listed once.");
    seen.add(component.catalogItemId);
    let units: bigint;
    try { units = quantityUnits(component.quantity.trim()); } catch {
      throw new SpecialComponentInputError(400, "Enter a component quantity like 1 or 1.5.");
    }
    if (units <= 0n || units > MAX_COMPONENT_UNITS) throw new SpecialComponentInputError(400, "Enter a component quantity greater than 0 and at most 1000.");
    return { catalogItemId: component.catalogItemId, quantity: quantityText(units) };
  });
  const db = await database();
  return db.transaction(async tx => {
    const option = rowsOf<{ catalogItemId: number; isWooManaged: boolean }>(await tx.execute(sql`
      SELECT co.catalog_item_id AS "catalogItemId", COALESCE(ci.is_woo_managed, false) AS "isWooManaged"
      FROM catalogue_options co
      JOIN catalog_items ci ON ci.tenant_id = co.tenant_id AND ci.id = co.catalog_item_id
      WHERE co.tenant_id = ${tenantId} AND co.id = ${optionId}
      FOR UPDATE OF co
    `))[0];
    if (!option) throw new SpecialComponentInputError(404, "Option not found");
    if (asBoolean(option.isWooManaged)) throw new SpecialComponentInputError(400, "A WooCommerce item cannot be a special.");
    const specialCatalogItemId = Number(option.catalogItemId);
    if (normalized.length === 0) {
      await tx.execute(sql`DELETE FROM catalogue_special_components
        WHERE tenant_id = ${tenantId} AND special_catalog_item_id = ${specialCatalogItemId}`);
      return [];
    }
    if (normalized.some(component => component.catalogItemId === specialCatalogItemId)) {
      throw new SpecialComponentInputError(400, "A special cannot include itself.");
    }
    const found = rowsOf<{ catalogItemId: number; productName: string; label: string; active: boolean; productActive: boolean; isAvailable: boolean; isWooManaged: boolean; complianceHold: boolean; inventoryItemId: number | null }>(await tx.execute(sql`
      SELECT co.catalog_item_id AS "catalogItemId", cp.name AS "productName", co.label,
        co.active, cp.active AS "productActive", ci.is_available AS "isAvailable",
        COALESCE(ci.is_woo_managed, false) AS "isWooManaged",
        COALESCE(ci.metadata->>'complianceHold' = 'true', false) AS "complianceHold",
        ii.id AS "inventoryItemId"
      FROM catalogue_options co
      JOIN catalogue_products cp ON cp.tenant_id = co.tenant_id AND cp.id = co.product_id
      JOIN catalog_items ci ON ci.tenant_id = co.tenant_id AND ci.id = co.catalog_item_id
      LEFT JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
      WHERE co.tenant_id = ${tenantId} AND co.catalog_item_id = ANY(${normalized.map(component => component.catalogItemId)}::int[])
    `));
    if (found.length !== normalized.length) throw new SpecialComponentInputError(400, "Choose components from this catalogue.");
    if (found.some(row => !asBoolean(row.active) || !asBoolean(row.productActive) || !asBoolean(row.isAvailable))) {
      throw new SpecialComponentInputError(400, "Each component must be an active product option.");
    }
    if (found.some(row => asBoolean(row.isWooManaged))) throw new SpecialComponentInputError(400, "Specials use local catalogue products.");
    if (found.some(row => asBoolean(row.complianceHold))) throw new SpecialComponentInputError(400, "A component on compliance hold cannot be added.");
    if (found.some(row => asNumber(row.inventoryItemId) == null)) throw new SpecialComponentInputError(400, "Each component needs its own inventory item.");
    const componentIds = normalized.map(component => component.catalogItemId);
    const nested = rowsOf<{ id: number }>(await tx.execute(sql`
      SELECT id FROM catalogue_special_components
      WHERE tenant_id = ${tenantId} AND special_catalog_item_id = ANY(${componentIds}::int[])
      LIMIT 1
    `));
    if (nested.length) throw new SpecialComponentInputError(400, "A special cannot include another special.");
    const usedBySpecial = rowsOf<{ id: number }>(await tx.execute(sql`
      SELECT id FROM catalogue_special_components
      WHERE tenant_id = ${tenantId} AND component_catalog_item_id = ${specialCatalogItemId}
      LIMIT 1
    `));
    if (usedBySpecial.length) throw new SpecialComponentInputError(400, "This product is already a component of another special.");
    await tx.execute(sql`DELETE FROM catalogue_special_components
      WHERE tenant_id = ${tenantId} AND special_catalog_item_id = ${specialCatalogItemId}`);
    const byId = new Map(found.map(row => [Number(row.catalogItemId), row]));
    for (const [index, component] of normalized.entries()) {
      await tx.execute(sql`
        INSERT INTO catalogue_special_components
          (tenant_id, special_catalog_item_id, component_catalog_item_id, quantity, sort_order)
        VALUES (${tenantId}, ${specialCatalogItemId}, ${component.catalogItemId}, ${component.quantity}::numeric, ${index})
      `);
    }
    return normalized.map(component => {
      const row = byId.get(component.catalogItemId)!;
      return {
        catalogItemId: component.catalogItemId,
        productName: row.productName,
        label: row.label,
        quantity: formatRetailQuantity(component.quantity),
      };
    });
  });
}
