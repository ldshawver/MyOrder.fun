import { Router, type IRouter } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, catalogItemsTable, auditLogsTable, inventoryTemplatesTable, inventoryLocationsTable, inventoryBalancesTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { logger } from "../lib/logger";
import { assertCatalogIdInventoryLookup } from "../lib/inventoryIdentityGuard";
import { postImportedInventoryBalanceCorrection, setCatalogBalanceParProjection, type InventoryMovementActor } from "../lib/inventoryMovementLedger";
import multer from "multer";
import * as XLSX from "xlsx";
import { createHash, randomBytes } from "node:crypto";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(csv|tsv|xlsx)$/i.test(file.originalname) || [
      "text/csv",
      "text/tab-separated-values",
      "text/plain",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ].includes(file.mimetype);
    cb(null, ok);
  },
});

export const CATALOG_IMPORT_HEADERS = [
  "Regular Price",
  "Sale Price",
  "Active Sale",
  "Alavont Category",
  "Alavont Name",
  "Alavont Image",
  "Alavont Description",
  "Alavont SKU",
  "Safe Category",
  "Safe Name",
  "Safe Image",
  "Safe Description",
  "Box 1 Inventory",
  "Box 2 Inventory",
  "Storefront Inventory",
  "Backstock Inventory",
  "Box 1 PAR",
  "Box 2 PAR",
  "Storefront PAR",
  "Backstock PAR",
] as const;
type CatalogImportHeader = (typeof CATALOG_IMPORT_HEADERS)[number];
const HEADER_SET = new Set<string>(CATALOG_IMPORT_HEADERS);
const IGNORED_LEGACY_HEADERS = new Set(["brand", "unit", "Unit", "quantity_size", "Quantity", "inventory_location", "par_level", "reorder_threshold", "sort_order", "alavont_in_stock", "lucifer_cruz_Inventory"]);
const REQUIRED_HEADERS: CatalogImportHeader[] = ["Regular Price", "Alavont Name", "Alavont Category", "Alavont SKU"];
const DANGEROUS_CELL = /^[=+\-@\t\r]/;
const MAX_ROWS = 5000;
const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;

const HEADER_ALIASES: Record<string, CatalogImportHeader> = {
  "regular price": "Regular Price",
  regular_price: "Regular Price",
  price: "Regular Price",
  "sale price": "Sale Price",
  sale_price: "Sale Price",
  "active sale": "Active Sale",
  active_sale: "Active Sale",
  active: "Active Sale",
  "alavont  category": "Alavont Category",
  "alavont category": "Alavont Category",
  alavont_category: "Alavont Category",
  category: "Alavont Category",
  "alavont name": "Alavont Name",
  alavont_name: "Alavont Name",
  name: "Alavont Name",
  "alavont image": "Alavont Image",
  alavont_image: "Alavont Image",
  image_url: "Alavont Image",
  "alavontb description": "Alavont Description",
  "alavont description": "Alavont Description",
  alavont_desc: "Alavont Description",
  description: "Alavont Description",
  "alavont  id": "Alavont SKU",
  "alavont id": "Alavont SKU",
  "alavont sku": "Alavont SKU",
  alavont_id: "Alavont SKU",
  sku: "Alavont SKU",
  "safe category": "Safe Category",
  "safe name": "Safe Name",
  "safe image": "Safe Image",
  "safe description": "Safe Description",
  lucifer_cruz_name: "Safe Name",
  lucifer_cruz_desc: "Safe Description",
  lucifer_cruz_category: "Safe Category",
  lucifer_cruz_image: "Safe Image",
  "box 1 inventory": "Box 1 Inventory",
  "box 2 inventory": "Box 2 Inventory",
  "storefront quantity": "Storefront Inventory",
  "storefront inventory": "Storefront Inventory",
  "backstock inventory": "Backstock Inventory",
  current_inventory: "Backstock Inventory",
  "box 1 par": "Box 1 PAR",
  "box 2 par": "Box 2 PAR",
  "storefront par": "Storefront PAR",
  "backstock par": "Backstock PAR",
  "box 1 par level": "Box 1 PAR",
  "box 2 par level": "Box 2 PAR",
  "storefront par level": "Storefront PAR",
  "backstock par level": "Backstock PAR",
};
type ParsedFile = { headers: string[]; rawHeaders: string[]; rows: string[][] };
type ImportRow = Record<CatalogImportHeader, string>;
type ImportDuplicateWarning = {
  type: "upload_duplicate_sku" | "db_duplicate_sku";
  key: string;
  rows: number[];
  sku: string | null;
  name: string | null;
};

type CatalogImportUpsertValues = typeof catalogItemsTable.$inferInsert;

const PRODUCT_MASTER_IMPORT_TEMPLATE = "alavont_safe_inventory_v2";
const COMPLIANCE_RULES = [
  ["cannabis", /\bcannabis\b/i], ["marijuana", /\bmarijuana\b/i], ["weed", /\bweed\b/i],
  ["thc", /\bthc\b/i], ["cocaine", /\bcocaine?\b/i], ["meth", /\bmeth\b/i],
  ["opioid", /\bopioids?\b/i], ["fentanyl", /\bfentanyl\b/i], ["psilocybin", /\bpsilocybin\b/i],
  ["magic mushroom", /\bmagic\s+mushrooms?\b/i], ["lsd", /\blsd\b/i], ["mdma", /\bmdma\b/i],
  ["controlled substance", /\bcontrolled\s+substances?\b/i], ["psychedelic", /\bpsychedelics?\b/i],
  ["hallucinogen", /\bhallucinogens?\b/i], ["stimulant", /\bstimulants?\b/i], ["depressant", /\bdepressants?\b/i],
] as const satisfies ReadonlyArray<readonly [string, RegExp]>;

export function classifyProductMasterCompliance(input: { name: string; category: string; description: string }) {
  const source = `${input.name} ${input.category} ${input.description}`;
  const matchedTerms = COMPLIANCE_RULES.filter(([, pattern]) => pattern.test(source)).map(([term]) => term);
  return {
    complianceHold: matchedTerms.length > 0,
    complianceReason: matchedTerms.length ? `Matched restricted term(s): ${matchedTerms.join(", ")}` : null,
    matchedTerms,
  };
}

function refreshedProductMasterMetadata(current: unknown, compliance: ReturnType<typeof classifyProductMasterCompliance>, activeSale: boolean) {
  const base = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {};
  const importManagedLifecycle = base.importTemplate === PRODUCT_MASTER_IMPORT_TEMPLATE || base.safeOnlyDuplicate === true || base.mergedIntoCatalogItemId != null;
  const merged: Record<string, unknown> = {
    ...base,
    activeSale,
    complianceHold: compliance.complianceHold,
    complianceReason: compliance.complianceReason,
    complianceMatchedTerms: compliance.matchedTerms,
    importTemplate: PRODUCT_MASTER_IMPORT_TEMPLATE,
  };
  if (importManagedLifecycle) {
    delete merged.archived;
    delete merged.safeOnlyDuplicate;
    delete merged.mergedIntoCatalogItemId;
  }
  return merged;
}

function executeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

type SnapshotPayload = {
  catalog: Array<typeof catalogItemsTable.$inferSelect>;
  inventoryTemplates: Array<typeof inventoryTemplatesTable.$inferSelect>;
  touchedSkus: string[];
  insertedCatalogIds: number[];
  insertedInventoryTemplateIds: number[];
};

function cleanHeader(raw: string): string { return raw.replace(/^\uFEFF/, "").trim().replace(/^['"]|['"]$/g, ""); }
function normalizeHeaderKey(raw: string): string { return cleanHeader(raw).replace(/\s+/g, " ").toLowerCase(); }
function canonicalizeHeader(raw: string): string {
  const cleaned = cleanHeader(raw);
  if (!cleaned) return "";
  return HEADER_ALIASES[normalizeHeaderKey(cleaned)] ?? cleaned;
}
function csvEscape(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (DANGEROUS_CELL.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function parseDelimitedLine(line: string, delim: string): string[] {
  const result: string[] = []; let cur = ""; let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQuote && line[i + 1] === '"') { cur += '"'; i++; } else inQuote = !inQuote; }
    else if (c === delim && !inQuote) { result.push(cur); cur = ""; }
    else cur += c;
  }
  result.push(cur);
  return result.map(s => s.trim());
}
function parseBuffer(buffer: Buffer, originalName: string): ParsedFile {
  const ext = originalName.split(".").pop()?.toLowerCase() ?? "csv";
  if (!["csv", "tsv", "xlsx"].includes(ext)) throw new Error("Only CSV, TSV, and XLSX files are supported");
  if (ext === "xlsx") {
    const workbook = XLSX.read(buffer, { type: "buffer", cellFormula: false, cellHTML: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    if (!data.length) return { headers: [], rawHeaders: [], rows: [] };
    const rawHeaders = data[0].map(String);
    return { rawHeaders, headers: rawHeaders.map(canonicalizeHeader), rows: data.slice(1).map(r => r.map(v => String(v ?? ""))) };
  }
  const text = buffer.toString("utf-8").replace(/^\uFEFF/, "");
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
  if (!lines.length) return { headers: [], rawHeaders: [], rows: [] };
  const delim = ext === "tsv" ? "\t" : (lines[0].includes("\t") && !lines[0].includes(",") ? "\t" : ",");
  const rawHeaders = parseDelimitedLine(lines[0], delim);
  return { rawHeaders, headers: rawHeaders.map(canonicalizeHeader), rows: lines.slice(1).map(l => parseDelimitedLine(l, delim)) };
}
function validateHeaders(headers: string[], rows: string[][] = []) {
  const activeHeaders = headers.filter((h, idx) => h || rows.some(row => String(row[idx] ?? "").trim()));
  const missing = REQUIRED_HEADERS.filter(h => !activeHeaders.includes(h));
  const extra = activeHeaders.filter(h => !HEADER_SET.has(h) && !IGNORED_LEGACY_HEADERS.has(h));
  const duplicates = activeHeaders.filter((h, i) => HEADER_SET.has(h) && activeHeaders.indexOf(h) !== i);
  return { ok: missing.length === 0 && extra.length === 0 && duplicates.length === 0, missing, extra, duplicates };
}
function parseNumber(raw: string, field: string, row: number, errors: { row: number; message: string }[], opts: { required?: boolean; min?: number } = {}): number | null {
  if (!raw.trim()) { if (opts.required) errors.push({ row, message: `${field} is required` }); return null; }
  const n = Number(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || (opts.min != null && n < opts.min)) { errors.push({ row, message: `${field} must be a valid number${opts.min != null ? ` >= ${opts.min}` : ""}` }); return null; }
  return n;
}
function parseBool(raw: string): boolean { return ["1", "true", "yes", "y", "active", "on"].includes(raw.trim().toLowerCase()); }
function safeText(raw: string, field: string, row: number, errors: { row: number; message: string }[], required = false): string {
  const value = raw.trim();
  if (required && !value) errors.push({ row, message: `${field} is required` });
  if (DANGEROUS_CELL.test(value)) errors.push({ row, message: `${field} cannot start with spreadsheet formula characters (=, +, -, @)` });
  if (value.length > 1000) errors.push({ row, message: `${field} is too long` });
  return value;
}
function safeUrl(raw: string, field: string, row: number, errors: { row: number; message: string }[]): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (DANGEROUS_CELL.test(value)) { errors.push({ row, message: `${field} cannot be a spreadsheet formula` }); return null; }
  try { const u = new URL(value); if (!["https:", "http:"].includes(u.protocol)) throw new Error("bad protocol"); return u.toString(); }
  catch { errors.push({ row, message: `${field} must be an http(s) URL` }); return null; }
}
function buildRecord(row: string[], headers: string[]): ImportRow {
  const out = Object.fromEntries(CATALOG_IMPORT_HEADERS.map(h => [h, ""])) as ImportRow;
  headers.forEach((h, i) => { if (HEADER_SET.has(h)) out[h as CatalogImportHeader] = row[i] ?? ""; });
  return out;
}
function buildUploadDuplicateWarnings(prepared: Array<{ row: number; values: typeof catalogItemsTable.$inferInsert }>): ImportDuplicateWarning[] {
  const bySku = new Map<string, Array<{ row: number; sku: string | null; name: string | null }>>();
  for (const p of prepared) {
    const sku = typeof p.values.sku === "string" ? p.values.sku : null;
    const name = typeof p.values.name === "string" ? p.values.name : null;
    const skuKey = String(sku ?? "").trim().toLowerCase();
    if (skuKey) bySku.set(skuKey, [...(bySku.get(skuKey) ?? []), { row: p.row, sku, name }]);
  }
  return [...bySku.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({ type: "upload_duplicate_sku" as const, key, rows: rows.map(r => r.row), sku: rows[0]?.sku ?? null, name: rows[0]?.name ?? null }));
}
function duplicateImportErrorMessage(warnings: ImportDuplicateWarning[]): string {
  const hasUpload = warnings.some(w => w.type.startsWith("upload_"));
  const hasDb = warnings.some(w => w.type.startsWith("db_"));
  if (hasUpload && hasDb) return "Uploaded spreadsheet and existing catalog contain duplicate products.";
  if (hasUpload) return "Uploaded spreadsheet contains duplicate products.";
  return "Existing catalog contains duplicate products.";
}


async function ensureSnapshotSchema(): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS catalog_import_snapshots (
    id serial PRIMARY KEY,
    tenant_id integer NOT NULL REFERENCES tenants(id),
    actor_id integer REFERENCES users(id),
    action text NOT NULL DEFAULT 'catalog_import',
    file_name text,
    snapshot jsonb NOT NULL,
    rolled_back_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
}

type PreviewTokenRecord = {
  id: number;
  tenant_id: number;
  actor_id: number;
  workbook_sha256: string;
  preview_request_id: string;
  expected_inserted: number;
  expected_updated: number;
  expected_visible: number;
  expected_held: number;
  expected_duplicates: number;
  expected_errors: number;
  source_state_sha256: string;
  expires_at: string | Date;
  consumed_at: string | Date | null;
};

async function ensurePreviewConfirmationSchema(): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS catalog_import_preview_tokens (
    id bigserial PRIMARY KEY,
    token_sha256 text NOT NULL UNIQUE,
    tenant_id integer NOT NULL REFERENCES tenants(id),
    actor_id integer NOT NULL REFERENCES users(id),
    workbook_sha256 text NOT NULL,
    preview_request_id text NOT NULL,
    expected_inserted integer NOT NULL,
    expected_updated integer NOT NULL,
    expected_visible integer NOT NULL,
    expected_held integer NOT NULL,
    expected_duplicates integer NOT NULL,
    expected_errors integer NOT NULL,
    source_state_sha256 text NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    confirmation_request_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS catalog_import_preview_tokens_expiry_idx
    ON catalog_import_preview_tokens (expires_at) WHERE consumed_at IS NULL`);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestId(req: import("express").Request): string {
  return String(req.id ?? req.get("x-request-id") ?? req.get("x-correlation-id") ?? "unknown");
}

function sourceStateHash(
  rows: Array<typeof catalogItemsTable.$inferSelect>,
  balances: Array<typeof inventoryBalancesTable.$inferSelect>,
  templates: Array<typeof inventoryTemplatesTable.$inferSelect>,
): string {
  const catalog = rows
    .map(row => ({
      id: row.id,
      sku: row.sku,
      alavontId: row.alavontId,
      merchantSku: row.merchantSku,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const inventory = balances.map(row => ({ id: row.id, productId: row.productId, locationId: row.locationId, quantityOnHand: row.quantityOnHand, parLevel: row.parLevel, updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt })).sort((a, b) => Number(a.id) - Number(b.id));
  const inventoryTemplates = templates.map(row => ({ id: row.id, catalogItemId: row.catalogItemId, currentStock: row.currentStock, parLevel: row.parLevel, updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt })).sort((a, b) => Number(a.id) - Number(b.id));
  return sha256(JSON.stringify({ catalog, inventory, inventoryTemplates }));
}

async function findOrCreateImportLocation(tx: typeof db, tenantId: number, importName: string) {
  const locationNames = importName === "Box 1" ? ["CSR Sales Box 1", "Box 1"] : importName === "Box 2" ? ["CSR Sales Box 2", "Box 2"] : [importName];
  for (const name of locationNames) {
    const [existing] = await tx.select().from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.name, name))).limit(1);
    if (existing) return existing;
  }
  const [created] = await tx.insert(inventoryLocationsTable).values({ tenantId, name: locationNames[0], type: importName === "Backstock" ? "backstock" : importName === "Storefront" ? "storefront" : "csr_box", isActive: true }).returning();
  return created;
}

async function upsertImportedInventoryRow(tx: typeof db, tenantId: number, catalogItemId: number, locationId: number, quantity: number, parLevel: number, actor: InventoryMovementActor, idempotencyKey: string) {
  assertCatalogIdInventoryLookup(catalogItemId, "upsertImportedInventoryRow");
  const movement = await postImportedInventoryBalanceCorrection(tx, {
    tenantId, actor, entityType: "catalog", itemId: catalogItemId, locationId, targetQuantity: String(quantity), sourceType: "inventory_import_baseline",
    sourceId: idempotencyKey, idempotencyKey, reasonCode: "import_baseline", reasonText: "Confirmed catalog import",
  });
  await setCatalogBalanceParProjection(tx, { tenantId, itemId: catalogItemId, locationId, parLevel: String(parLevel) });
  return movement;
}

async function upsertImportedInventoryTemplate(tx: typeof db, tenantId: number, catalogItemId: number, itemName: string, quantity: number, parLevel: number) {
  assertCatalogIdInventoryLookup(catalogItemId, "upsertImportedInventoryTemplate");
  const [existing] = await tx.select().from(inventoryTemplatesTable).where(and(eq(inventoryTemplatesTable.tenantId, tenantId), eq(inventoryTemplatesTable.catalogItemId, catalogItemId))).limit(1);
  const values = { itemName, rowType: "item", unitType: "#", startingQuantityDefault: "0", currentStock: null, parLevel: String(parLevel), isActive: true, updatedAt: new Date() };
  if (existing) await tx.update(inventoryTemplatesTable).set(values).where(and(eq(inventoryTemplatesTable.tenantId, tenantId), eq(inventoryTemplatesTable.id, existing.id)));
  else await tx.insert(inventoryTemplatesTable).values({ tenantId, catalogItemId, ...values });
}

async function audit(req: import("express").Request, action: string, tenantId: number, metadata: Record<string, unknown>, resourceId?: string) {
  const actor = req.dbUser!;
  await db.insert(auditLogsTable).values({ actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, tenantId, action, resourceType: "catalog_import", resourceId, metadata, ipAddress: req.ip ?? undefined });
}

router.get("/admin/products/import-template", requireRole("global_admin", "admin"), async (_req, res) => {
  const sample = ["29.99", "19.99", "false", "Wellness", "Sample Product", "https://example.com/product.jpg", "Sample description", "SKU-001", "Safe Wellness", "Safe Sample Product", "https://example.com/safe.jpg", "Safe payment description", "5", "4", "3", "25", "2", "2", "2", "10"];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="catalog_import_template.csv"');
  res.send([CATALOG_IMPORT_HEADERS.map(csvEscape).join(","), sample.map(csvEscape).join(",")].join("\n"));
});
router.get("/admin/products/import-spec", requireRole("global_admin", "admin"), (_req, res) => { res.json({ spec: { version: 1, columns: CATALOG_IMPORT_HEADERS.map(h => ({ id: h, header: h, canonical: h, required: REQUIRED_HEADERS.includes(h), sampleValue: "", locked: true })) } }); } );

router.post("/admin/products/parse-headers", requireRole("global_admin", "admin"), upload.single("file") as never, async (req, res) => {
  if (!req.file?.buffer) { res.status(400).json({ error: "No file provided" }); return; }
  try {
    const parsed = parseBuffer(req.file.buffer, req.file.originalname);
    const v = validateHeaders(parsed.headers, parsed.rows);
    res.json({ headerMappings: parsed.headers.map((h, i) => ({ original: parsed.rawHeaders[i] ?? h, canonical: h, recognized: HEADER_SET.has(h) })), missingRequired: v.missing, unknownHeaders: v.extra, duplicateHeaders: v.duplicates, requiredFields: REQUIRED_HEADERS.map(h => ({ canonical: h, friendlyName: h, found: parsed.headers.includes(h), mappedFrom: parsed.rawHeaders[parsed.headers.indexOf(h)] ?? null })), fileColumns: parsed.rawHeaders, allCanonicals: CATALOG_IMPORT_HEADERS.map(h => ({ canonical: h, friendlyName: h, required: REQUIRED_HEADERS.includes(h) })) });
  } catch (e) { res.status(400).json({ error: `Could not parse file: ${(e as Error).message}` }); }
});

router.get("/admin/products/export", requireRole("global_admin", "admin"), async (req, res) => {
  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
  const rows = await db.select().from(catalogItemsTable).where(eq(catalogItemsTable.tenantId, tenantId)) as Array<typeof catalogItemsTable.$inferSelect>;
  const catalogIds = rows.map((r: typeof catalogItemsTable.$inferSelect) => r.id);
  const [locations, balances] = await Promise.all([
    db.select().from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.isActive, true))),
    catalogIds.length ? db.select().from(inventoryBalancesTable).where(and(eq(inventoryBalancesTable.tenantId, tenantId), inArray(inventoryBalancesTable.productId, catalogIds))) : Promise.resolve([]),
  ]);
  const locById = new Map(locations.map(l => [l.id, l.name]));
  const qtyByProductLocation = new Map<string, string>();
  for (const b of balances as Array<typeof inventoryBalancesTable.$inferSelect>) qtyByProductLocation.set(`${b.productId}:${locById.get(b.locationId)}`, String(b.quantityOnHand ?? "0"));
  const lines = [CATALOG_IMPORT_HEADERS.map(csvEscape).join(",")];
  for (const item of rows) {
    const regular = item.regularPrice ?? item.price ?? "0";
    const sale = item.compareAtPrice ?? item.homiePrice ?? "";
    const activeSale = sale && String(item.price) === String(sale) ? "true" : "false";
    lines.push([
      regular,
      sale,
      activeSale,
      item.alavontCategory ?? item.category,
      item.alavontName ?? item.name,
      item.alavontImageUrl ?? item.imageUrl ?? "",
      item.alavontDescription ?? item.description ?? "",
      item.alavontId ?? item.sku ?? item.merchantSku ?? "",
      item.luciferCruzCategory ?? item.merchantCategory ?? item.category,
      item.luciferCruzName ?? item.merchantName ?? item.customerSafeName ?? item.name,
      item.luciferCruzImageUrl ?? item.merchantImage ?? item.imageUrl ?? "",
      item.luciferCruzDescription ?? item.merchantDescription ?? item.customerSafeDescription ?? item.description ?? "",
      qtyByProductLocation.get(`${item.id}:Box 1`) ?? qtyByProductLocation.get(`${item.id}:CSR Sales Box 1`) ?? "0",
      qtyByProductLocation.get(`${item.id}:Box 2`) ?? qtyByProductLocation.get(`${item.id}:CSR Sales Box 2`) ?? "0",
      qtyByProductLocation.get(`${item.id}:Storefront`) ?? "0",
      qtyByProductLocation.get(`${item.id}:Backstock`) ?? "0",
    ].map(csvEscape).join(","));
  }
  await audit(req, "catalog_export", tenantId, { count: rows.length });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="catalog_export.csv"');
  res.send(lines.join("\n"));
});

router.post(["/admin/products/import", "/admin/import/catalog", "/admin/import/product-master"], requireRole("global_admin", "admin"), upload.single("file") as never, async (req, res) => {
  const actor = req.dbUser!; const tenantId = actor.tenantId ?? await getHouseTenantId(); const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
  const uploadedFileName = req.file?.originalname;
  const confirmed = req.body?.confirm === "true" || req.body?.confirm === true || req.query.confirm === "true";
  if (!req.file?.buffer) { res.status(400).json({ error: "A CSV, TSV, or XLSX file upload is required" }); return; }
  let parsed: ParsedFile;
  try { parsed = parseBuffer(req.file.buffer, req.file.originalname); } catch (e) { res.status(400).json({ error: `Could not parse file: ${(e as Error).message}` }); return; }
  if (parsed.rows.length > MAX_ROWS) { res.status(413).json({ error: `Import is limited to ${MAX_ROWS} data rows` }); return; }
  const v = validateHeaders(parsed.headers, parsed.rows);
  if (v.missing.length) { res.status(400).json({ error: `Missing required column(s): ${v.missing.join(", ")}`, missingColumns: v.missing }); return; }
  if (v.extra.length) { res.status(400).json({ error: `Unexpected column(s): ${v.extra.join(", ")}`, extraColumns: v.extra }); return; }
  if (v.duplicates.length) { res.status(400).json({ error: `Duplicate column(s): ${Array.from(new Set(v.duplicates)).join(", ")}`, duplicateColumns: v.duplicates }); return; }

  const errors: { row: number; message: string }[] = [];
  const prepared: Array<{ row: number; rec: ImportRow; values: CatalogImportUpsertValues; updateValues: Partial<CatalogImportUpsertValues>; inventory: Record<string, number>; par: Record<string, number>; compliance: ReturnType<typeof classifyProductMasterCompliance>; activeSale: boolean }> = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const rowNum = i + 2; const rec = buildRecord(parsed.rows[i], parsed.headers);
    const sku = safeText(rec["Alavont SKU"], "Alavont SKU", rowNum, errors, true);
    const name = safeText(rec["Alavont Name"], "Alavont Name", rowNum, errors, true);
    const category = safeText(rec["Alavont Category"], "Alavont Category", rowNum, errors, true);
    const regularPrice = parseNumber(rec["Regular Price"], "Regular Price", rowNum, errors, { required: true, min: 0 });
    const salePrice = parseNumber(rec["Sale Price"], "Sale Price", rowNum, errors, { min: 0 });
    const activeSale = rec["Active Sale"].trim() ? parseBool(rec["Active Sale"]) : false;
    const checkoutPrice = activeSale && salePrice !== null ? salePrice : regularPrice;
    const inventory = {
      "Box 1": parseNumber(rec["Box 1 Inventory"], "Box 1 Inventory", rowNum, errors, { min: 0 }) ?? 0,
      "Box 2": parseNumber(rec["Box 2 Inventory"], "Box 2 Inventory", rowNum, errors, { min: 0 }) ?? 0,
      Storefront: parseNumber(rec["Storefront Inventory"], "Storefront Inventory", rowNum, errors, { min: 0 }) ?? 0,
      Backstock: parseNumber(rec["Backstock Inventory"], "Backstock Inventory", rowNum, errors, { min: 0 }) ?? 0,
    };
    const par = {
      "Box 1": parseNumber(rec["Box 1 PAR"], "Box 1 PAR", rowNum, errors, { min: 0 }) ?? 0,
      "Box 2": parseNumber(rec["Box 2 PAR"], "Box 2 PAR", rowNum, errors, { min: 0 }) ?? 0,
      Storefront: parseNumber(rec["Storefront PAR"], "Storefront PAR", rowNum, errors, { min: 0 }) ?? 0,
      Backstock: parseNumber(rec["Backstock PAR"], "Backstock PAR", rowNum, errors, { min: 0 }) ?? 0,
    };
    if (!sku || !name || !category || regularPrice === null || checkoutPrice === null) continue;
    const imageUrl = safeUrl(rec["Alavont Image"], "Alavont Image", rowNum, errors); const customerSafeImageUrl = safeUrl(rec["Safe Image"], "Safe Image", rowNum, errors);
    const customerSafeName = safeText(rec["Safe Name"] || name, "Safe Name", rowNum, errors);
    const customerSafeDescription = safeText(rec["Safe Description"], "Safe Description", rowNum, errors) || null;
    const customerSafeCategory = safeText(rec["Safe Category"] || category, "Safe Category", rowNum, errors) || category;
    const compliance = classifyProductMasterCompliance({ name, category, description: rec["Alavont Description"] });
    const { complianceHold } = compliance;
    const totalInventory = String(Object.values(inventory).reduce((a, b) => a + b, 0).toFixed(2));
    const importValues: CatalogImportUpsertValues = { tenantId, sku, merchantSku: sku, name, description: safeText(rec["Alavont Description"], "Alavont Description", rowNum, errors) || null, category, price: checkoutPrice.toFixed(2), regularPrice: regularPrice.toFixed(2), compareAtPrice: salePrice !== null ? salePrice.toFixed(2) : null, stockUnit: "#", inventoryAmount: totalInventory, stockQuantity: totalInventory, isAvailable: !complianceHold, imageUrl, alavontName: name, alavontDescription: rec["Alavont Description"] || null, alavontCategory: category, alavontImageUrl: imageUrl, alavontInStock: !complianceHold, alavontId: sku, externalMenuId: sku, luciferCruzName: customerSafeName, luciferCruzDescription: customerSafeDescription, luciferCruzCategory: customerSafeCategory, luciferCruzImageUrl: customerSafeImageUrl, customerSafeName: customerSafeName, customerSafeDescription: customerSafeDescription, merchantName: customerSafeName, merchantDescription: customerSafeDescription, merchantCategory: customerSafeCategory, merchantImage: customerSafeImageUrl, merchantBrand: "alavont", parLevel: String(Object.values(par).reduce((a, b) => a + b, 0).toFixed(2)), isWooManaged: false, isLocalAlavont: true, receiptName: customerSafeName, labelName: customerSafeName, labName: sku, metadata: refreshedProductMasterMetadata({}, compliance, activeSale) };
    const updateValues: Partial<CatalogImportUpsertValues> = {
      customerSafeName: customerSafeName,
      customerSafeDescription: customerSafeDescription,
      name,
      description: rec["Alavont Description"] || null,
      category,
      alavontName: name,
      alavontDescription: rec["Alavont Description"] || null,
      alavontCategory: category,
      alavontImageUrl: imageUrl,
      alavontId: sku,
      externalMenuId: sku,
      luciferCruzName: customerSafeName,
      luciferCruzDescription: customerSafeDescription,
      luciferCruzCategory: customerSafeCategory,
      luciferCruzImageUrl: customerSafeImageUrl,
      sku,
      merchantSku: sku,
      price: checkoutPrice.toFixed(2),
      regularPrice: regularPrice.toFixed(2),
      compareAtPrice: salePrice !== null ? salePrice.toFixed(2) : null,
      isAvailable: !complianceHold,
      alavontInStock: !complianceHold,
      isLocalAlavont: true,
      isWooManaged: false,
      inventoryAmount: totalInventory,
      stockQuantity: totalInventory,
      merchantName: customerSafeName,
      merchantDescription: customerSafeDescription,
      merchantCategory: customerSafeCategory,
      merchantImage: customerSafeImageUrl,
      merchantBrand: "alavont",
      updatedAt: new Date(),
    };
    prepared.push({ row: rowNum, rec, inventory, par, values: importValues, updateValues, compliance, activeSale });
  }
  const allTenantCatalog = await db.select().from(catalogItemsTable).where(eq(catalogItemsTable.tenantId, tenantId)) as Array<typeof catalogItemsTable.$inferSelect>;
  const duplicateWarnings = buildUploadDuplicateWarnings(prepared);
  const catalogIds = allTenantCatalog.map(item => item.id);
  const inventoriedProductIds = new Set<number>();
  let inventoriedRows: Array<typeof inventoryBalancesTable.$inferSelect> = [];
  let inventoryTemplateRows: Array<typeof inventoryTemplatesTable.$inferSelect> = [];
  if (catalogIds.length > 0) {
    inventoriedRows = await db
      .select()
      .from(inventoryBalancesTable)
      .where(and(eq(inventoryBalancesTable.tenantId, tenantId), inArray(inventoryBalancesTable.productId, catalogIds)));
    inventoryTemplateRows = await db.select().from(inventoryTemplatesTable).where(and(eq(inventoryTemplatesTable.tenantId, tenantId), inArray(inventoryTemplatesTable.catalogItemId, catalogIds)));
    for (const row of inventoriedRows) inventoriedProductIds.add(row.productId);
  }
  const preferCanonical = (currentId: number | undefined, candidateId: number): number => {
    if (!currentId) return candidateId;
    const currentHasInventory = inventoriedProductIds.has(currentId);
    const candidateHasInventory = inventoriedProductIds.has(candidateId);
    if (candidateHasInventory !== currentHasInventory) return candidateHasInventory ? candidateId : currentId;
    return Math.min(currentId, candidateId);
  };
  const bySku = new Map<string, number>();
  const byAlavontOrMerchantSku = new Map<string, number>();
  for (const item of allTenantCatalog) {
    const skuKey = String(item.sku ?? "").trim().toLowerCase();
    const merchantKey = String(item.alavontId ?? item.merchantSku ?? "").trim().toLowerCase();
    if (skuKey) bySku.set(skuKey, preferCanonical(bySku.get(skuKey), item.id));
    if (merchantKey) byAlavontOrMerchantSku.set(merchantKey, preferCanonical(byAlavontOrMerchantSku.get(merchantKey), item.id));
  }
  const preview = prepared.map(p => {
    const skuKey = String(p.values.sku ?? "").trim().toLowerCase();
    const matchedId = bySku.get(skuKey) ?? byAlavontOrMerchantSku.get(skuKey) ?? null;
    const compliance = p.compliance;
    return { row: p.row, oldProductId: matchedId, matchedProductId: matchedId, sku: p.values.sku, name: p.values.name, category: p.values.category, isAvailable: !compliance.complianceHold, alavontInStock: !compliance.complianceHold, complianceHold: compliance.complianceHold, complianceReason: compliance.complianceReason, complianceMatchedTerms: compliance.matchedTerms, parValues: p.par, duplicateWarnings: duplicateWarnings.filter(w => w.key === skuKey || w.rows.includes(p.row)) };
  });
  const matchedIds = new Set(preview.map(p => p.matchedProductId).filter((id): id is number => typeof id === "number"));
  const expectedCounts = {
    inserted: prepared.length - matchedIds.size,
    updated: matchedIds.size,
    visible: preview.filter(item => item.isAvailable).length,
    held: preview.filter(item => item.complianceHold).length,
    duplicates: duplicateWarnings.length,
    errors: errors.length,
  };
  const workbookSha256 = sha256(req.file.buffer);
  const currentSourceStateSha256 = sourceStateHash(allTenantCatalog, inventoriedRows, inventoryTemplateRows);
  if (duplicateWarnings.length) {
    logger.warn({ tenantId, count: duplicateWarnings.length, first10Warnings: duplicateWarnings.slice(0, 10) }, "import_duplicate_block");
    res.status(409).json({ error: duplicateImportErrorMessage(duplicateWarnings), duplicateWarnings, preview, inserted: 0, updated: 0 });
    return;
  }
  if (!confirmed && !dryRun) {
    await ensurePreviewConfirmationSchema();
    const opaqueToken = randomBytes(32).toString("base64url");
    const tokenSha256 = sha256(opaqueToken);
    const previewRequestId = requestId(req);
    const expiresAt = new Date(Date.now() + PREVIEW_TOKEN_TTL_MS);
    await db.execute(sql`INSERT INTO catalog_import_preview_tokens (
      token_sha256, tenant_id, actor_id, workbook_sha256, preview_request_id,
      expected_inserted, expected_updated, expected_visible, expected_held,
      expected_duplicates, expected_errors, source_state_sha256, expires_at
    ) VALUES (
      ${tokenSha256}, ${tenantId}, ${actor.id}, ${workbookSha256}, ${previewRequestId},
      ${expectedCounts.inserted}, ${expectedCounts.updated}, ${expectedCounts.visible}, ${expectedCounts.held},
      ${expectedCounts.duplicates}, ${expectedCounts.errors}, ${currentSourceStateSha256}, ${expiresAt}
    )`);
    res.status(409).json({
      error: "Catalog import can overwrite existing catalog, inventory, and par values. Re-submit with confirm=true after reviewing the preview.",
      requiresConfirmation: true,
      previewConfirmationToken: opaqueToken,
      previewTokenExpiresAt: expiresAt.toISOString(),
      previewRequestId,
      preview,
      wouldInsert: expectedCounts.inserted,
      wouldUpdate: expectedCounts.updated,
    });
    return;
  }
  if (dryRun || errors.length) { res.json({ dryRun: true, inserted: Math.max(0, prepared.length - matchedIds.size), updated: matchedIds.size, skipped: 0, errors, total: prepared.length, warnings: matchedIds.size ? [`${matchedIds.size} existing products would be updated.`] : [], duplicateWarnings, preview }); return; }

  const opaqueToken = String(req.body?.previewConfirmationToken ?? "").trim();
  const confirmationRequestId = requestId(req);
  const rejectConfirmation = async (reason: string, status = 409) => {
    await audit(req, "catalog_import_confirmation_rejected", tenantId, { reason, confirmationRequestId, workbookSha256 });
    res.status(status).json({ error: "Import confirmation is invalid or expired. Run a new preview before confirming.", code: reason });
  };
  if (!opaqueToken) { await rejectConfirmation("PREVIEW_TOKEN_REQUIRED", 400); return; }
  await ensurePreviewConfirmationSchema();
  const tokenSha256 = sha256(opaqueToken);
  const tokenRows = executeRows<PreviewTokenRecord>(await db.execute(sql`SELECT
    id, tenant_id, actor_id, workbook_sha256, preview_request_id,
    expected_inserted, expected_updated, expected_visible, expected_held,
    expected_duplicates, expected_errors, source_state_sha256, expires_at, consumed_at
    FROM catalog_import_preview_tokens WHERE token_sha256 = ${tokenSha256} LIMIT 1`));
  const tokenRecord = tokenRows[0];
  if (!tokenRecord) { await rejectConfirmation("PREVIEW_TOKEN_INVALID"); return; }
  if (tokenRecord.consumed_at) { await rejectConfirmation("PREVIEW_TOKEN_CONSUMED"); return; }
  if (new Date(tokenRecord.expires_at).getTime() <= Date.now()) { await rejectConfirmation("PREVIEW_TOKEN_EXPIRED"); return; }
  if (tokenRecord.actor_id !== actor.id) { await rejectConfirmation("PREVIEW_TOKEN_ACTOR_MISMATCH", 403); return; }
  if (tokenRecord.tenant_id !== tenantId) { await rejectConfirmation("PREVIEW_TOKEN_TENANT_MISMATCH", 403); return; }
  if (tokenRecord.workbook_sha256 !== workbookSha256) { await rejectConfirmation("PREVIEW_TOKEN_WORKBOOK_MISMATCH"); return; }
  const countsMatch = tokenRecord.expected_inserted === expectedCounts.inserted
    && tokenRecord.expected_updated === expectedCounts.updated
    && tokenRecord.expected_visible === expectedCounts.visible
    && tokenRecord.expected_held === expectedCounts.held
    && tokenRecord.expected_duplicates === expectedCounts.duplicates
    && tokenRecord.expected_errors === expectedCounts.errors;
  if (!countsMatch || tokenRecord.source_state_sha256 !== currentSourceStateSha256) { await rejectConfirmation("PREVIEW_STATE_CHANGED"); return; }

  try {
    const importResult = await db.transaction(async (tx: typeof db) => {
      const consumed = executeRows<{ id: number }>(await tx.execute(sql`UPDATE catalog_import_preview_tokens
        SET consumed_at = now(), confirmation_request_id = ${confirmationRequestId}
        WHERE id = ${tokenRecord.id} AND consumed_at IS NULL AND expires_at > now()
        RETURNING id`));
      if (consumed.length !== 1) throw new Error("PREVIEW_TOKEN_ALREADY_USED");
      let inserted = 0;
      let updated = 0;
      for (const p of prepared) {
        const skuKey = String(p.values.sku ?? "").trim().toLowerCase();
const existingId =
  bySku.get(skuKey) ??
  byAlavontOrMerchantSku.get(skuKey) ??
  null;

let catalogItemId = existingId;
        if (catalogItemId) {
          const existingRow = allTenantCatalog.find(item => item.id === catalogItemId);
          await tx.update(catalogItemsTable).set({
            ...p.updateValues,
            metadata: refreshedProductMasterMetadata(existingRow?.metadata, p.compliance, p.activeSale),
          }).where(and(eq(catalogItemsTable.id, catalogItemId), eq(catalogItemsTable.tenantId, tenantId)));
          updated++;
        } else {
          const [created] = await tx.insert(catalogItemsTable).values(p.values).returning({ id: catalogItemsTable.id });
          catalogItemId = created.id;
          inserted++;
        }
        if (!catalogItemId) throw new Error("Catalog import did not return a catalog item id");
        const resolvedCatalogItemId = catalogItemId;
        for (const [importName, quantity] of Object.entries(p.inventory)) {
          const location = await findOrCreateImportLocation(tx, tenantId, importName);
          const parLevel = p.par[importName] ?? 0;
          await upsertImportedInventoryRow(tx, tenantId, resolvedCatalogItemId, location.id, quantity, parLevel, { id: actor.id, email: actor.email, role: actor.role, ipAddress: req.ip }, `import:${confirmationRequestId}:${resolvedCatalogItemId}:${location.id}`);
        }
        await upsertImportedInventoryTemplate(tx, tenantId, resolvedCatalogItemId, String(p.values.name ?? p.values.alavontName ?? p.values.customerSafeName), Object.values(p.inventory).reduce((sum, qty) => sum + qty, 0), Object.values(p.par).reduce((sum, qty) => sum + qty, 0));
      }
      await tx.insert(auditLogsTable).values({
        actorId: actor.id,
        actorEmail: actor.email ?? "",
        actorRole: actor.role,
        tenantId,
        action: "catalog_import",
        resourceType: "catalog_import",
        metadata: {
          fileName: uploadedFileName,
          inserted,
          updated,
          total: prepared.length,
          workbookSha256,
          previewRequestId: tokenRecord.preview_request_id,
          confirmationRequestId,
          previewCounts: expectedCounts,
          committedCounts: { inserted, updated },
        },
        ipAddress: req.ip ?? undefined,
      });
      return { inserted, updated };
    });
    res.json({ inserted: importResult.inserted, updated: importResult.updated, skipped: 0, errors: [] });
  } catch (e) {
    if ((e as Error).message === "PREVIEW_TOKEN_ALREADY_USED") { await rejectConfirmation("PREVIEW_TOKEN_CONSUMED"); return; }
    res.status(500).json({ error: `Import failed before completion and no catalog changes were committed: ${(e as Error).message}` });
  }
});

router.post("/admin/products/import/rollback", requireRole("global_admin", "admin"), async (req, res) => {
  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId(); await ensureSnapshotSchema();
  const snapshotRows = executeRows<{ id: number; snapshot: SnapshotPayload }>(await db.execute(sql`SELECT id, snapshot FROM catalog_import_snapshots WHERE tenant_id = ${tenantId} AND rolled_back_at IS NULL ORDER BY created_at DESC LIMIT 1`));
  const snapshotRow = snapshotRows[0];
  if (!snapshotRow) { res.status(404).json({ error: "No unrolled catalog import snapshot found for this tenant" }); return; }
  const payload = snapshotRow.snapshot;
  for (const id of payload.insertedInventoryTemplateIds ?? []) await db.delete(inventoryTemplatesTable).where(and(eq(inventoryTemplatesTable.id, id), eq(inventoryTemplatesTable.tenantId, tenantId)));
  for (const id of payload.insertedCatalogIds ?? []) await db.delete(catalogItemsTable).where(and(eq(catalogItemsTable.id, id), eq(catalogItemsTable.tenantId, tenantId)));
  for (const item of payload.catalog) await db.update(catalogItemsTable).set(item).where(and(eq(catalogItemsTable.id, item.id), eq(catalogItemsTable.tenantId, tenantId)));
  for (const tmpl of payload.inventoryTemplates) await db.update(inventoryTemplatesTable).set(tmpl).where(and(eq(inventoryTemplatesTable.id, tmpl.id), eq(inventoryTemplatesTable.tenantId, tenantId)));
  await db.execute(sql`UPDATE catalog_import_snapshots SET rolled_back_at = now() WHERE id = ${snapshotRow.id} AND tenant_id = ${tenantId}`);
  await audit(req, "catalog_import_rollback", tenantId, { snapshotId: snapshotRow.id, restoredCatalog: payload.catalog.length, restoredInventoryTemplates: payload.inventoryTemplates.length });
  res.json({ rolledBack: true, snapshotId: snapshotRow.id, restoredCatalog: payload.catalog.length, restoredInventoryTemplates: payload.inventoryTemplates.length });
});

// Compatibility aliases.
router.get("/admin/import/catalog-template", requireRole("global_admin", "admin"), (_req, res) => { res.redirect(307, "/api/admin/products/import-template"); });
router.get("/admin/import/product-master-template", requireRole("global_admin", "admin"), (_req, res) => { res.redirect(307, "/api/admin/products/import-template"); });

export default router;
