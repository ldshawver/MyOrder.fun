import { sql } from "drizzle-orm";
import { auditLogsTable, db } from "@workspace/db";
import { ensureStandardLocations } from "./inventoryBalances";
import { InventoryMovementError, postCatalogOpeningCount, postInventoryMovement, postInventoryReceipt, type InventoryMovementActor } from "./inventoryMovementLedger";
import {
  FLOOR_LOCAL_CATALOG_SQL,
  buildCountStops,
  buildFloorSheet,
  canonicalizeFloorCost,
  canonicalizeFloorDecimal,
  floorAttempt,
  floorIdempotencyKey,
  floorQuantityFitsBalance,
  nextStopIndex,
  openingUnitCost,
  planPhysicalCount,
  summarizeFloorLines,
  valuationCanFundIncrease,
  type FloorEntityType,
  type FloorLineIdentity,
  type FloorLocation,
  type FloorNoteKind,
  type FloorOutcome,
  type FloorScope,
  type FloorSheetItem,
  type FloorStop,
  type RawFloorProduct,
} from "./inventoryFloorPlan";
import { normalizeRole } from "./roles";

export class FloorFlowError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly sessionId?: number) {
    super(message);
    this.name = "FloorFlowError";
  }
}

export type FloorSheet = { locations: FloorLocation[]; items: FloorSheetItem[] };

export type FloorLine = FloorLineIdentity & {
  id: number;
  quantity: string | null;
  bookQuantity: string | null;
};

export type FloorNote = {
  id: number;
  sessionId: number;
  kind: FloorNoteKind;
  body: string;
  itemName: string | null;
  locationName: string | null;
  createdAt: string;
  authorFirstName: string | null;
};

export type FloorSessionView = {
  session: {
    id: number;
    kind: "count" | "receive";
    scope: FloorScope | null;
    locationId: number | null;
    locationName: string | null;
    reference: string | null;
    supplierReference: string | null;
    status: string;
  };
  stops: FloorStop[];
  lines: FloorLine[];
  notes: FloorNote[];
  nextIndex: number;
  summary: ReturnType<typeof summarizeFloorLines>;
};

type SessionRow = {
  id: number;
  tenantId: number;
  actorUserId: number;
  kind: "count" | "receive";
  scope: FloorScope | null;
  locationId: number | null;
  reference: string | null;
  supplierReference: string | null;
  status: string;
};

type LineRow = {
  id: number;
  locationId: number;
  entityType: FloorEntityType;
  itemId: number;
  quantity: string | null;
  bookQuantity: string | null;
  outcome: FloorOutcome;
  attempt: number;
};

let schemaReady = false;

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null | undefined)?.rows ?? []);
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && (current as { code?: string }).code === "23505") return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function canOperate(actor: InventoryMovementActor, sessionActorId: number): boolean {
  if (actor.id === sessionActorId) return true;
  const role = normalizeRole(actor.role);
  return role === "supervisor" || role === "admin" || role === "global_admin";
}

export async function ensureInventoryFloorSchema(): Promise<void> {
  if (schemaReady) return;
  const statements = [
    sql`CREATE TABLE IF NOT EXISTS inventory_floor_sessions (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL,
      actor_user_id integer NOT NULL,
      kind text NOT NULL CHECK (kind IN ('count', 'receive')),
      scope text CHECK (scope IS NULL OR scope IN ('one', 'all')),
      location_id integer,
      reference text,
      supplier_reference text,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'abandoned')),
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    )`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS inventory_floor_one_open
      ON inventory_floor_sessions (tenant_id, actor_user_id, kind)
      WHERE status = 'open'`,
    sql`CREATE TABLE IF NOT EXISTS inventory_floor_lines (
      id serial PRIMARY KEY,
      session_id integer NOT NULL,
      tenant_id integer NOT NULL,
      location_id integer NOT NULL,
      entity_type text NOT NULL CHECK (entity_type IN ('catalog', 'non_catalog')),
      item_id integer NOT NULL,
      book_quantity numeric(24, 12),
      quantity numeric(24, 12),
      unit_cost numeric(24, 12),
      movement_id integer,
      receipt_id integer,
      outcome text NOT NULL CHECK (outcome IN ('unchanged', 'corrected', 'opened', 'received', 'skipped')),
      attempt integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS inventory_floor_lines_attempt_unique
      ON inventory_floor_lines (session_id, location_id, entity_type, item_id, attempt)`,
    sql`CREATE TABLE IF NOT EXISTS inventory_floor_notes (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL,
      session_id integer NOT NULL,
      location_id integer,
      entity_type text,
      item_id integer,
      kind text NOT NULL CHECK (kind IN ('add_item', 'change_item', 'general')),
      body text NOT NULL,
      item_name text,
      location_name text,
      created_by_user_id integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  ];
  for (const statement of statements) await db.execute(statement);
  schemaReady = true;
}

async function specialCatalogIds(tenantId: number): Promise<Set<number>> {
  const present = rows<{ name: string | null }>(await db.execute(sql`SELECT to_regclass('public.catalogue_special_components')::text AS name`))[0];
  if (!present?.name) return new Set();
  const ids = rows<{ id: number }>(await db.execute(sql`SELECT DISTINCT special_catalog_item_id AS id FROM catalogue_special_components WHERE tenant_id = ${tenantId}`));
  return new Set(ids.map(row => Number(row.id)));
}

export async function loadFloorSheet(tenantId: number): Promise<FloorSheet> {
  await ensureInventoryFloorSchema();
  await ensureStandardLocations(tenantId);
  const [locations, catalog, nonCatalog, catalogBalances, nonCatalogBalances, valuations, specials] = await Promise.all([
    db.execute(sql`SELECT id, name, type, COALESCE(display_order, 0) AS "displayOrder" FROM inventory_locations WHERE tenant_id = ${tenantId} AND is_active = true ORDER BY display_order, id`),
    db.execute(sql`SELECT ci.id, ci.name, NULLIF(ci.alavont_name, '') AS "alavontName", COALESCE(NULLIF(ci.stock_unit, ''), '#') AS unit, COALESCE(NULLIF(ci.alavont_category, ''), NULLIF(ci.category, ''), 'Uncategorized') AS category, ci.cost_basis::text AS "costBasis" FROM catalog_items ci WHERE ci.tenant_id = ${tenantId} AND ${sql.raw(FLOOR_LOCAL_CATALOG_SQL)}`),
    db.execute(sql`SELECT i.id, i.name, COALESCE(NULLIF(i.unit_of_measure, ''), 'each') AS unit, COALESCE(s.name, 'Supplies') AS category, i.unit_cost::text AS "unitCost" FROM non_catalog_inventory_items i LEFT JOIN non_catalog_inventory_sections s ON s.id = i.section_id AND s.tenant_id = i.tenant_id WHERE i.tenant_id = ${tenantId} AND i.is_active = true`),
    db.execute(sql`SELECT product_id AS "itemId", location_id AS "locationId", quantity_on_hand::text AS quantity FROM inventory_balances WHERE tenant_id = ${tenantId}`),
    db.execute(sql`SELECT item_id AS "itemId", location_id AS "locationId", quantity_on_hand::text AS quantity FROM non_catalog_inventory_balances WHERE tenant_id = ${tenantId}`),
    db.execute(sql`SELECT catalog_item_id AS "catalogItemId", non_catalog_item_id AS "nonCatalogItemId", last_purchase_unit_cost::text AS "lastPurchase", average_unit_cost::text AS average FROM inventory_valuation_states WHERE tenant_id = ${tenantId}`),
    specialCatalogIds(tenantId),
  ]);
  const locationRows = rows<FloorLocation>(locations);
  const catalogBalanceRows = rows<{ itemId: number; locationId: number; quantity: string }>(catalogBalances);
  const supplyBalanceRows = rows<{ itemId: number; locationId: number; quantity: string }>(nonCatalogBalances);
  const valuationRows = rows<{ catalogItemId: number | null; nonCatalogItemId: number | null; lastPurchase: string | null; average: string | null }>(valuations);
  const products: RawFloorProduct[] = [
    ...rows<{ id: number; name: string; alavontName: string | null; unit: string; category: string; costBasis: string | null }>(catalog).map(item => {
      const valuation = valuationRows.find(row => Number(row.catalogItemId) === Number(item.id));
      return {
        entityType: "catalog" as const,
        itemId: Number(item.id),
        name: item.name,
        subtitle: item.alavontName,
        unit: item.unit,
        category: item.category,
        special: specials.has(Number(item.id)),
        costCandidates: [valuation?.lastPurchase ?? null, valuation?.average ?? null, item.costBasis],
        balances: catalogBalanceRows.filter(row => Number(row.itemId) === Number(item.id)).map(row => ({ locationId: Number(row.locationId), quantity: String(row.quantity) })),
      };
    }),
    ...rows<{ id: number; name: string; unit: string; category: string; unitCost: string | null }>(nonCatalog).map(item => {
      const valuation = valuationRows.find(row => Number(row.nonCatalogItemId) === Number(item.id));
      return {
        entityType: "non_catalog" as const,
        itemId: Number(item.id),
        name: item.name,
        subtitle: null,
        unit: item.unit,
        category: item.category,
        special: false,
        costCandidates: [valuation?.lastPurchase ?? null, valuation?.average ?? null, item.unitCost],
        balances: supplyBalanceRows.filter(row => Number(row.itemId) === Number(item.id)).map(row => ({ locationId: Number(row.locationId), quantity: String(row.quantity) })),
      };
    }),
  ];
  return { locations: locationRows.map(location => ({ ...location, id: Number(location.id), displayOrder: Number(location.displayOrder) })), items: buildFloorSheet(locationRows, products) };
}

const SESSION_COLUMNS = `id, tenant_id AS "tenantId", actor_user_id AS "actorUserId", kind, scope, location_id AS "locationId", reference, supplier_reference AS "supplierReference", status`;

async function readSession(tenantId: number, sessionId: number): Promise<SessionRow | null> {
  const row = rows<SessionRow>(await db.execute(sql`SELECT ${sql.raw(SESSION_COLUMNS)} FROM inventory_floor_sessions WHERE tenant_id = ${tenantId} AND id = ${sessionId} LIMIT 1`))[0];
  return row ?? null;
}

async function loadLines(tenantId: number, sessionId: number): Promise<FloorLine[]> {
  return rows<LineRow>(await db.execute(sql`SELECT id, location_id AS "locationId", entity_type AS "entityType", item_id AS "itemId", quantity::text AS quantity, book_quantity::text AS "bookQuantity", outcome, attempt FROM inventory_floor_lines WHERE tenant_id = ${tenantId} AND session_id = ${sessionId} ORDER BY id`)).map(line => ({
    ...line,
    id: Number(line.id),
    locationId: Number(line.locationId),
    itemId: Number(line.itemId),
    attempt: Number(line.attempt),
    quantity: line.quantity == null ? null : String(line.quantity),
    bookQuantity: line.bookQuantity == null ? null : String(line.bookQuantity),
  }));
}

async function loadSessionNotes(tenantId: number, sessionId: number): Promise<FloorNote[]> {
  return rows<FloorNote>(await db.execute(sql`SELECT n.id, n.session_id AS "sessionId", n.kind, n.body, n.item_name AS "itemName", n.location_name AS "locationName", n.created_at AS "createdAt", u.first_name AS "authorFirstName" FROM inventory_floor_notes n LEFT JOIN users u ON u.id = n.created_by_user_id WHERE n.tenant_id = ${tenantId} AND n.session_id = ${sessionId} ORDER BY n.id`)).map(note => ({ ...note, id: Number(note.id), sessionId: Number(note.sessionId) }));
}

async function present(tenantId: number, session: SessionRow): Promise<FloorSessionView> {
  const sheet = await loadFloorSheet(tenantId);
  const location = sheet.locations.find(row => row.id === Number(session.locationId));
  const stops = session.kind === "count" && session.scope && session.locationId
    ? buildCountStops(sheet.items, sheet.locations, Number(session.locationId), session.scope)
    : [];
  const lines = await loadLines(tenantId, session.id);
  return {
    session: {
      id: Number(session.id),
      kind: session.kind,
      scope: session.scope,
      locationId: session.locationId == null ? null : Number(session.locationId),
      locationName: location?.name ?? null,
      reference: session.reference,
      supplierReference: session.supplierReference,
      status: session.status,
    },
    stops,
    lines,
    notes: await loadSessionNotes(tenantId, session.id),
    nextIndex: nextStopIndex(stops, lines),
    summary: summarizeFloorLines(lines),
  };
}

export async function findOpenFloorSession(tenantId: number, actorId: number, kind: "count" | "receive"): Promise<FloorSessionView | null> {
  await ensureInventoryFloorSchema();
  const session = rows<SessionRow>(await db.execute(sql`SELECT ${sql.raw(SESSION_COLUMNS)} FROM inventory_floor_sessions WHERE tenant_id = ${tenantId} AND actor_user_id = ${actorId} AND kind = ${kind} AND status = 'open' ORDER BY id DESC LIMIT 1`))[0];
  return session ? present(tenantId, session) : null;
}

export async function getFloorSession(tenantId: number, sessionId: number): Promise<FloorSessionView | null> {
  await ensureInventoryFloorSchema();
  const session = await readSession(tenantId, sessionId);
  return session ? present(tenantId, session) : null;
}

async function activeLocation(tenantId: number, locationId: number): Promise<{ id: number; name: string }> {
  const location = rows<{ id: number; name: string }>(await db.execute(sql`SELECT id, name FROM inventory_locations WHERE tenant_id = ${tenantId} AND id = ${locationId} AND is_active = true LIMIT 1`))[0];
  if (!location) throw new FloorFlowError(404, "That location is not on the list.");
  return { id: Number(location.id), name: location.name };
}

export async function createCountSession(tenantId: number, actor: InventoryMovementActor, scope: FloorScope, locationId: number): Promise<FloorSessionView> {
  await ensureInventoryFloorSchema();
  await activeLocation(tenantId, locationId);
  try {
    const session = rows<SessionRow>(await db.execute(sql`INSERT INTO inventory_floor_sessions (tenant_id, actor_user_id, kind, scope, location_id, status) VALUES (${tenantId}, ${actor.id}, 'count', ${scope}, ${locationId}, 'open') RETURNING ${sql.raw(SESSION_COLUMNS)}`))[0];
    if (!session) throw new FloorFlowError(500, "The count could not be started.");
    return present(tenantId, session);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const open = await findOpenFloorSession(tenantId, actor.id, "count");
    throw new FloorFlowError(409, "You already have a count in progress.", "SESSION_OPEN", open?.session.id);
  }
}

export async function createReceiveSession(tenantId: number, actor: InventoryMovementActor, locationId: number, reference: string | null, supplierReference: string | null): Promise<FloorSessionView> {
  await ensureInventoryFloorSchema();
  await activeLocation(tenantId, locationId);
  try {
    const session = rows<SessionRow>(await db.execute(sql`INSERT INTO inventory_floor_sessions (tenant_id, actor_user_id, kind, location_id, reference, supplier_reference, status) VALUES (${tenantId}, ${actor.id}, 'receive', ${locationId}, ${reference}, ${supplierReference}, 'open') RETURNING ${sql.raw(SESSION_COLUMNS)}`))[0];
    if (!session) throw new FloorFlowError(500, "The order could not be started.");
    return present(tenantId, session);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const open = await findOpenFloorSession(tenantId, actor.id, "receive");
    throw new FloorFlowError(409, "You already have an order coming in.", "SESSION_OPEN", open?.session.id);
  }
}

async function lockSession(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tenantId: number, sessionId: number, actor: InventoryMovementActor, kind: "count" | "receive"): Promise<SessionRow> {
  const session = rows<SessionRow>(await tx.execute(sql`SELECT ${sql.raw(SESSION_COLUMNS)} FROM inventory_floor_sessions WHERE tenant_id = ${tenantId} AND id = ${sessionId} FOR UPDATE`))[0];
  if (!session || session.kind !== kind) throw new FloorFlowError(404, kind === "count" ? "That count was not found." : "That order was not found.");
  if (session.status !== "open") throw new FloorFlowError(409, kind === "count" ? "This count is already finished." : "This order is already finished.");
  if (!canOperate(actor, Number(session.actorUserId))) throw new FloorFlowError(403, "This one belongs to someone else.");
  return session;
}

type CountTarget = { unit: string; costHint: string | null; average: string | null; costStatus: string | null };

async function assertCountTarget(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tenantId: number, entityType: FloorEntityType, itemId: number): Promise<CountTarget> {
  if (entityType === "catalog") {
    const item = rows<{ id: number; unit: string; costBasis: string | null }>(await tx.execute(sql`SELECT ci.id, COALESCE(NULLIF(ci.stock_unit, ''), '#') AS unit, ci.cost_basis::text AS "costBasis" FROM catalog_items ci WHERE ci.tenant_id = ${tenantId} AND ci.id = ${itemId} AND ${sql.raw(FLOOR_LOCAL_CATALOG_SQL)} LIMIT 1`))[0];
    if (!item) throw new FloorFlowError(404, "That item is not on the local inventory list.");
    const special = rows<{ name: string | null }>(await tx.execute(sql`SELECT to_regclass('public.catalogue_special_components')::text AS name`))[0];
    if (special?.name) {
      const component = rows<{ id: number }>(await tx.execute(sql`SELECT id FROM catalogue_special_components WHERE tenant_id = ${tenantId} AND special_catalog_item_id = ${itemId} LIMIT 1`))[0];
      if (component) throw new FloorFlowError(409, "That package sells from its ingredients, so it is not counted on its own.");
    }
    const valuation = rows<{ costStatus: string; average: string | null; lastPurchase: string | null }>(await tx.execute(sql`SELECT cost_status AS "costStatus", average_unit_cost::text AS average, last_purchase_unit_cost::text AS "lastPurchase" FROM inventory_valuation_states WHERE tenant_id = ${tenantId} AND catalog_item_id = ${itemId} LIMIT 1`))[0];
    return { unit: item.unit, costHint: openingUnitCost(null, valuation?.average, valuation?.lastPurchase ?? item.costBasis), average: valuation?.average ?? null, costStatus: valuation?.costStatus ?? null };
  }
  const item = rows<{ id: number; unit: string; unitCost: string | null }>(await tx.execute(sql`SELECT id, COALESCE(NULLIF(unit_of_measure, ''), 'each') AS unit, unit_cost::text AS "unitCost" FROM non_catalog_inventory_items WHERE tenant_id = ${tenantId} AND id = ${itemId} AND is_active = true LIMIT 1`))[0];
  if (!item) throw new FloorFlowError(404, "That supply is not on the list.");
  const valuation = rows<{ costStatus: string; average: string | null; lastPurchase: string | null }>(await tx.execute(sql`SELECT cost_status AS "costStatus", average_unit_cost::text AS average, last_purchase_unit_cost::text AS "lastPurchase" FROM inventory_valuation_states WHERE tenant_id = ${tenantId} AND non_catalog_item_id = ${itemId} LIMIT 1`))[0];
  return { unit: item.unit, costHint: openingUnitCost(null, valuation?.average, valuation?.lastPurchase ?? item.unitCost), average: valuation?.average ?? null, costStatus: valuation?.costStatus ?? null };
}

async function liveBook(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tenantId: number, entityType: FloorEntityType, itemId: number, locationId: number): Promise<{ hasBalance: boolean; quantity: string | null }> {
  const row = entityType === "catalog"
    ? rows<{ quantity: string }>(await tx.execute(sql`SELECT quantity_on_hand::text AS quantity FROM inventory_balances WHERE tenant_id = ${tenantId} AND product_id = ${itemId} AND location_id = ${locationId} FOR UPDATE`))[0]
    : rows<{ quantity: string }>(await tx.execute(sql`SELECT quantity_on_hand::text AS quantity FROM non_catalog_inventory_balances WHERE tenant_id = ${tenantId} AND item_id = ${itemId} AND location_id = ${locationId} FOR UPDATE`))[0];
  return row ? { hasBalance: true, quantity: String(row.quantity) } : { hasBalance: false, quantity: null };
}

async function insertLine(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], input: { tenantId: number; sessionId: number; locationId: number; entityType: FloorEntityType; itemId: number; bookQuantity: string | null; quantity: string | null; unitCost: string | null; movementId: number | null; receiptId: number | null; outcome: FloorOutcome; attempt: number }): Promise<number> {
  const inserted = rows<{ id: number }>(await tx.execute(sql`INSERT INTO inventory_floor_lines (session_id, tenant_id, location_id, entity_type, item_id, book_quantity, quantity, unit_cost, movement_id, receipt_id, outcome, attempt) VALUES (${input.sessionId}, ${input.tenantId}, ${input.locationId}, ${input.entityType}, ${input.itemId}, ${input.bookQuantity}, ${input.quantity}, ${input.unitCost}, ${input.movementId}, ${input.receiptId}, ${input.outcome}, ${input.attempt}) ON CONFLICT (session_id, location_id, entity_type, item_id, attempt) DO NOTHING RETURNING id`))[0];
  if (inserted) return Number(inserted.id);
  const existing = rows<{ id: number }>(await tx.execute(sql`SELECT id FROM inventory_floor_lines WHERE session_id = ${input.sessionId} AND location_id = ${input.locationId} AND entity_type = ${input.entityType} AND item_id = ${input.itemId} AND attempt = ${input.attempt} LIMIT 1`))[0];
  if (!existing) throw new FloorFlowError(409, "That entry was just saved. Open it again.");
  return Number(existing.id);
}

async function insertNonCatalogZero(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], input: { tenantId: number; actor: InventoryMovementActor; itemId: number; locationId: number; unit: string; idempotencyKey: string; sessionId: number }): Promise<number> {
  const existing = rows<{ id: number }>(await tx.execute(sql`SELECT id FROM inventory_movements WHERE tenant_id = ${input.tenantId} AND idempotency_key = ${input.idempotencyKey} AND movement_index = 0 LIMIT 1`))[0];
  if (existing) return Number(existing.id);
  const balance = rows<{ id: number }>(await tx.execute(sql`INSERT INTO non_catalog_inventory_balances (tenant_id, item_id, location_id, quantity_on_hand, updated_at) VALUES (${input.tenantId}, ${input.itemId}, ${input.locationId}, 0, now()) ON CONFLICT (tenant_id, item_id, location_id) DO NOTHING RETURNING id`))[0];
  if (!balance) throw new FloorFlowError(409, "That supply already has a balance. Count it again.");
  const posted = rows<{ id: number }>(await tx.execute(sql`INSERT INTO inventory_movements (tenant_id, inventory_entity_type, catalog_item_id, non_catalog_item_id, location_id, movement_type, quantity_delta, unit_of_measure, extended_cost, pre_quantity, post_quantity, source_type, source_id, reason_code, reason_text, idempotency_key, movement_index, correlation_id, actor_user_id) VALUES (${input.tenantId}, 'non_catalog', NULL, ${input.itemId}, ${input.locationId}, 'correction', 0, ${input.unit}, 0, 0, 0, 'verified_opening_count', ${String(input.sessionId)}, 'opening_count', 'Physical inventory count', ${input.idempotencyKey}, 0, ${input.idempotencyKey}, ${input.actor.id}) RETURNING id`))[0];
  if (!posted) throw new FloorFlowError(500, "The zero count could not be saved.");
  await tx.insert(auditLogsTable).values({ tenantId: input.tenantId, actorId: input.actor.id, actorEmail: input.actor.email ?? "", actorRole: input.actor.role, action: "inventory.opening_count_recorded", resourceType: "inventory_movement", resourceId: String(posted.id), metadata: { itemId: input.itemId, locationId: input.locationId, quantity: "0", entityType: "non_catalog", sessionId: input.sessionId } });
  return Number(posted.id);
}

export async function recordCountLine(tenantId: number, actor: InventoryMovementActor, sessionId: number, input: { locationId: number; entityType: FloorEntityType; itemId: number; quantity: string; attempt: number; unitCost?: string | null }): Promise<{ needsUnitCost: true } | { needsUnitCost: false; view: FloorSessionView }> {
  await ensureInventoryFloorSchema();
  const counted = canonicalizeFloorDecimal(input.quantity);
  if (counted == null) throw new FloorFlowError(422, "Enter a quantity like 12 or 3.5.");
  if (!floorQuantityFitsBalance(input.entityType, counted)) {
    throw new FloorFlowError(422, input.entityType === "non_catalog"
      ? "Enter a supply quantity with up to 3 decimal places, under 10 million."
      : "Enter a quantity with up to 6 decimal places.");
  }
  const attempt = floorAttempt(input.attempt);
  if (attempt == null) throw new FloorFlowError(422, "That count attempt is not valid.");
  const explicitCost = input.unitCost == null || input.unitCost.trim() === "" ? null : canonicalizeFloorCost(input.unitCost);
  if (input.unitCost != null && input.unitCost.trim() !== "" && explicitCost == null) throw new FloorFlowError(422, "Enter a cost like 4.50.");
  const outcome = await db.transaction(async tx => {
    const session = await lockSession(tx, tenantId, sessionId, actor, "count");
    if (session.scope === "one" && Number(session.locationId) !== input.locationId) throw new FloorFlowError(422, "This count is for one location.");
    const location = rows<{ id: number }>(await tx.execute(sql`SELECT id FROM inventory_locations WHERE tenant_id = ${tenantId} AND id = ${input.locationId} AND is_active = true LIMIT 1`))[0];
    if (!location) throw new FloorFlowError(404, "That location is not on the list.");
    const target = await assertCountTarget(tx, tenantId, input.entityType, input.itemId);
    const existing = rows<{ id: number; outcome: string; quantity: string | null }>(await tx.execute(sql`SELECT id, outcome, quantity::text AS quantity FROM inventory_floor_lines WHERE session_id = ${sessionId} AND location_id = ${input.locationId} AND entity_type = ${input.entityType} AND item_id = ${input.itemId} AND attempt = ${attempt} LIMIT 1`))[0];
    if (existing) {
      if (existing.outcome === "skipped") throw new FloorFlowError(409, "That item was skipped. Count it again to change it.");
      if (canonicalizeFloorDecimal(String(existing.quantity ?? "")) !== counted) throw new FloorFlowError(409, "That count was already saved with a different quantity.");
      return { needsUnitCost: false as const };
    }
    const advisoryItem = input.entityType === "catalog" ? input.itemId : -input.itemId;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}, ${advisoryItem})`);
    const book = await liveBook(tx, tenantId, input.entityType, input.itemId, input.locationId);
    let plan;
    try { plan = planPhysicalCount(book.hasBalance ? book.quantity : null, counted); }
    catch (error) { throw new FloorFlowError(422, error instanceof Error ? error.message : "That quantity could not be read."); }
    const idempotencyKey = floorIdempotencyKey("count", sessionId, input.locationId, input.entityType, input.itemId, attempt);
    let movementId: number | null = null;
    let unitCost: string | null = null;
    let lineOutcome: FloorOutcome = "unchanged";
    if (plan.action === "opening" && plan.needsUnitCost) {
      unitCost = openingUnitCost(explicitCost, target.average, target.costHint);
      if (!unitCost) return { needsUnitCost: true as const };
      if (input.entityType === "catalog") {
        const movement = await postCatalogOpeningCount(tx, { tenantId, actor, itemId: input.itemId, locationId: input.locationId, quantity: plan.quantity, unitCost, reasonText: "Physical inventory count", evidenceReference: `floor-session-${sessionId}`, idempotencyKey });
        movementId = movement.id;
      } else {
        const movement = await postInventoryMovement(tx, { tenantId, actor, entityType: "non_catalog", itemId: input.itemId, locationId: input.locationId, movementType: "correction", direction: "increase", quantity: plan.quantity, unitCost, sourceType: "verified_opening_count", sourceId: String(sessionId), reasonCode: "opening_count", reasonText: "Physical inventory count", idempotencyKey });
        movementId = movement.id;
      }
      lineOutcome = "opened";
    } else if (plan.action === "opening") {
      movementId = input.entityType === "catalog"
        ? (await postCatalogOpeningCount(tx, { tenantId, actor, itemId: input.itemId, locationId: input.locationId, quantity: "0", reasonText: "Physical inventory count", evidenceReference: `floor-session-${sessionId}`, idempotencyKey })).id
        : await insertNonCatalogZero(tx, { tenantId, actor, itemId: input.itemId, locationId: input.locationId, unit: target.unit, idempotencyKey, sessionId });
      lineOutcome = "opened";
    } else if (plan.action === "correction") {
      if (plan.direction === "increase" && !valuationCanFundIncrease(target.costStatus, target.average)) {
        unitCost = explicitCost;
        if (!unitCost) return { needsUnitCost: true as const };
      }
      const movement = await postInventoryMovement(tx, { tenantId, actor, entityType: input.entityType, itemId: input.itemId, locationId: input.locationId, movementType: "correction", direction: plan.direction, quantity: plan.quantity, unitCost: unitCost ?? undefined, sourceType: "inventory_floor_count", sourceId: String(sessionId), reasonCode: "physical_count", reasonText: "Physical inventory count", idempotencyKey });
      movementId = movement.id;
      lineOutcome = "corrected";
    }
    await insertLine(tx, { tenantId, sessionId, locationId: input.locationId, entityType: input.entityType, itemId: input.itemId, bookQuantity: book.quantity, quantity: counted, unitCost, movementId, receiptId: null, outcome: lineOutcome, attempt });
    return { needsUnitCost: false as const };
  });
  if (outcome.needsUnitCost) return outcome;
  const view = await getFloorSession(tenantId, sessionId);
  if (!view) throw new FloorFlowError(404, "That count was not found.");
  return { needsUnitCost: false, view };
}

export async function skipCountLine(tenantId: number, actor: InventoryMovementActor, sessionId: number, input: { locationId: number; entityType: FloorEntityType; itemId: number; attempt: number }): Promise<FloorSessionView> {
  await ensureInventoryFloorSchema();
  const attempt = floorAttempt(input.attempt);
  if (attempt == null) throw new FloorFlowError(422, "That count attempt is not valid.");
  await db.transaction(async tx => {
    const session = await lockSession(tx, tenantId, sessionId, actor, "count");
    if (session.scope === "one" && Number(session.locationId) !== input.locationId) throw new FloorFlowError(422, "This count is for one location.");
    await assertCountTarget(tx, tenantId, input.entityType, input.itemId);
    const existing = rows<{ id: number; outcome: string }>(await tx.execute(sql`SELECT id, outcome FROM inventory_floor_lines WHERE session_id = ${sessionId} AND location_id = ${input.locationId} AND entity_type = ${input.entityType} AND item_id = ${input.itemId} AND attempt = ${attempt} LIMIT 1`))[0];
    if (existing) {
      if (existing.outcome !== "skipped") throw new FloorFlowError(409, "That item already has a saved count.");
      return;
    }
    await insertLine(tx, { tenantId, sessionId, locationId: input.locationId, entityType: input.entityType, itemId: input.itemId, bookQuantity: null, quantity: null, unitCost: null, movementId: null, receiptId: null, outcome: "skipped", attempt });
  });
  const view = await getFloorSession(tenantId, sessionId);
  if (!view) throw new FloorFlowError(404, "That count was not found.");
  return view;
}

export async function recordReceiveLine(tenantId: number, actor: InventoryMovementActor, sessionId: number, input: { entityType: FloorEntityType; itemId: number; quantity: string; attempt: number; unitCost?: string | null }): Promise<{ needsUnitCost: true } | { needsUnitCost: false; view: FloorSessionView }> {
  await ensureInventoryFloorSchema();
  const quantity = canonicalizeFloorDecimal(input.quantity);
  if (quantity == null || quantity === "0") throw new FloorFlowError(422, "Enter how many arrived, more than zero.");
  if (!floorQuantityFitsBalance("non_catalog", quantity)) throw new FloorFlowError(422, "Enter a quantity with up to 3 decimal places.");
  const attempt = floorAttempt(input.attempt);
  if (attempt == null) throw new FloorFlowError(422, "That entry attempt is not valid.");
  const explicitCost = input.unitCost == null || input.unitCost.trim() === "" ? null : canonicalizeFloorCost(input.unitCost);
  if (input.unitCost != null && input.unitCost.trim() !== "" && explicitCost == null) throw new FloorFlowError(422, "Enter a cost like 4.50.");
  const outcome = await db.transaction(async tx => {
    const session = await lockSession(tx, tenantId, sessionId, actor, "receive");
    const locationId = Number(session.locationId);
    const target = await assertCountTarget(tx, tenantId, input.entityType, input.itemId);
    const existing = rows<{ id: number; quantity: string | null }>(await tx.execute(sql`SELECT id, quantity::text AS quantity FROM inventory_floor_lines WHERE session_id = ${sessionId} AND location_id = ${locationId} AND entity_type = ${input.entityType} AND item_id = ${input.itemId} AND attempt = ${attempt} AND outcome = 'received' LIMIT 1`))[0];
    if (existing) {
      if (canonicalizeFloorDecimal(String(existing.quantity ?? "")) !== quantity) throw new FloorFlowError(409, "That arrival was already saved with a different quantity.");
      return { needsUnitCost: false as const };
    }
    const unitCost = explicitCost ?? target.costHint;
    if (!unitCost) return { needsUnitCost: true as const };
    const idempotencyKey = floorIdempotencyKey("receive", sessionId, locationId, input.entityType, input.itemId, attempt);
    const posted = await postInventoryReceipt(tx, { tenantId, actor, entityType: input.entityType, itemId: input.itemId, locationId, quantity, unitCost, supplierReference: session.supplierReference, reference: session.reference ?? `Floor receipt ${sessionId}`, idempotencyKey });
    await insertLine(tx, { tenantId, sessionId, locationId, entityType: input.entityType, itemId: input.itemId, bookQuantity: null, quantity, unitCost, movementId: posted.movement.id, receiptId: posted.receipt?.id ?? null, outcome: "received", attempt });
    return { needsUnitCost: false as const };
  });
  if (outcome.needsUnitCost) return outcome;
  const view = await getFloorSession(tenantId, sessionId);
  if (!view) throw new FloorFlowError(404, "That order was not found.");
  return { needsUnitCost: false, view };
}

async function itemLabel(tenantId: number, entityType: FloorEntityType | null, itemId: number | null): Promise<string | null> {
  if (entityType == null || itemId == null) return null;
  if (entityType === "catalog") {
    const item = rows<{ name: string }>(await db.execute(sql`SELECT COALESCE(NULLIF(alavont_name, ''), name) AS name FROM catalog_items WHERE tenant_id = ${tenantId} AND id = ${itemId} LIMIT 1`))[0];
    return item?.name ?? null;
  }
  const item = rows<{ name: string }>(await db.execute(sql`SELECT name FROM non_catalog_inventory_items WHERE tenant_id = ${tenantId} AND id = ${itemId} LIMIT 1`))[0];
  return item?.name ?? null;
}

export async function addFloorNote(tenantId: number, actor: InventoryMovementActor, sessionId: number, input: { kind: FloorNoteKind; body: string; locationId?: number | null; entityType?: FloorEntityType | null; itemId?: number | null }): Promise<FloorNote> {
  await ensureInventoryFloorSchema();
  const body = input.body.trim();
  if (body.length < 1 || body.length > 1000) throw new FloorFlowError(422, "Write a note of 1,000 characters or less.");
  const session = await readSession(tenantId, sessionId);
  if (!session) throw new FloorFlowError(404, "That session was not found.");
  if (session.status !== "open") throw new FloorFlowError(409, "This session is already finished.");
  if (!canOperate(actor, Number(session.actorUserId))) throw new FloorFlowError(403, "This one belongs to someone else.");
  const count = rows<{ count: number }>(await db.execute(sql`SELECT count(*)::int AS count FROM inventory_floor_notes WHERE session_id = ${sessionId}`))[0];
  if (Number(count?.count ?? 0) >= 100) throw new FloorFlowError(422, "This session already has 100 notes.");
  const locationId = input.locationId ?? session.locationId;
  const location = locationId == null ? null : rows<{ name: string }>(await db.execute(sql`SELECT name FROM inventory_locations WHERE tenant_id = ${tenantId} AND id = ${locationId} LIMIT 1`))[0];
  const itemName = await itemLabel(tenantId, input.entityType ?? null, input.itemId ?? null);
  const note = rows<FloorNote>(await db.execute(sql`INSERT INTO inventory_floor_notes (tenant_id, session_id, location_id, entity_type, item_id, kind, body, item_name, location_name, created_by_user_id) VALUES (${tenantId}, ${sessionId}, ${location?.name ? locationId : null}, ${input.entityType ?? null}, ${itemName ? input.itemId ?? null : null}, ${input.kind}, ${body}, ${itemName}, ${location?.name ?? null}, ${actor.id}) RETURNING id, session_id AS "sessionId", kind, body, item_name AS "itemName", location_name AS "locationName", created_at AS "createdAt"`))[0];
  if (!note) throw new FloorFlowError(500, "The note could not be saved.");
  await db.insert(auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "inventory.floor_note", resourceType: "inventory_floor_session", resourceId: String(sessionId), metadata: { noteId: note.id, kind: input.kind, itemId: input.itemId ?? null, locationId: locationId ?? null } });
  return { ...note, id: Number(note.id), sessionId: Number(note.sessionId), authorFirstName: null };
}

export async function listRecentFloorNotes(tenantId: number): Promise<FloorNote[]> {
  await ensureInventoryFloorSchema();
  return rows<FloorNote>(await db.execute(sql`SELECT n.id, n.session_id AS "sessionId", n.kind, n.body, n.item_name AS "itemName", n.location_name AS "locationName", n.created_at AS "createdAt", u.first_name AS "authorFirstName" FROM inventory_floor_notes n LEFT JOIN users u ON u.id = n.created_by_user_id WHERE n.tenant_id = ${tenantId} ORDER BY n.id DESC LIMIT 40`)).map(note => ({ ...note, id: Number(note.id), sessionId: Number(note.sessionId) }));
}

async function finishSession(tenantId: number, actor: InventoryMovementActor, sessionId: number, kind: "count" | "receive", status: "completed" | "abandoned"): Promise<FloorSessionView> {
  await ensureInventoryFloorSchema();
  const session = await db.transaction(async tx => {
    const locked = await lockSession(tx, tenantId, sessionId, actor, kind);
    const updated = rows<SessionRow>(await tx.execute(sql`UPDATE inventory_floor_sessions SET status = ${status}, completed_at = now() WHERE id = ${locked.id} RETURNING ${sql.raw(SESSION_COLUMNS)}`))[0];
    if (!updated) throw new FloorFlowError(404, "That session was not found.");
    await tx.insert(auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: status === "completed" ? "inventory.floor_session_completed" : "inventory.floor_session_abandoned", resourceType: "inventory_floor_session", resourceId: String(sessionId), metadata: { kind, status } });
    return updated;
  });
  return present(tenantId, session);
}

export function completeFloorSession(tenantId: number, actor: InventoryMovementActor, sessionId: number, kind: "count" | "receive"): Promise<FloorSessionView> {
  return finishSession(tenantId, actor, sessionId, kind, "completed");
}

export function abandonFloorSession(tenantId: number, actor: InventoryMovementActor, sessionId: number, kind: "count" | "receive"): Promise<FloorSessionView> {
  return finishSession(tenantId, actor, sessionId, kind, "abandoned");
}
