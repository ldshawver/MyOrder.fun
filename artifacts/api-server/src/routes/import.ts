import { Router, type IRouter } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, catalogItemsTable, auditLogsTable, inventoryTemplatesTable, inventoryLocationsTable, inventoryBalancesTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { logger } from "../lib/logger";
import multer from "multer";
import * as XLSX from "xlsx";

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
  safe_category: "Safe Category",
  "safe name": "Safe Name",
  safe_name: "Safe Name",
  "safe image": "Safe Image",
  safe_image_url: "Safe Image",
  "safe description": "Safe Description",
  safe_description: "Safe Description",
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
  type: "upload_duplicate_sku" | "upload_duplicate_name" | "db_duplicate_sku" | "db_duplicate_name";
  key: string;
  rows: number[];
  sku: string | null;
  name: string | null;
};

type CatalogImportUpsertValues = typeof catalogItemsTable.$inferInsert;

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
function normalizeProductName(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function buildUploadDuplicateWarnings(prepared: Array<{ row: number; values: typeof catalogItemsTable.$inferInsert; normalizedSafeName: string }>): ImportDuplicateWarning[] {
  const bySku = new Map<string, Array<{ row: number; sku: string | null; name: string | null }>>();
  const byName = new Map<string, Array<{ row: number; sku: string | null; name: string | null }>>();
  for (const p of prepared) {
    const sku = typeof p.values.sku === "string" ? p.values.sku : null;
    const name = typeof p.values.name === "string" ? p.values.name : null;
    const skuKey = String(sku ?? "").trim().toLowerCase();
    if (skuKey) bySku.set(skuKey, [...(bySku.get(skuKey) ?? []), { row: p.row, sku, name }]);
    if (p.normalizedSafeName) byName.set(p.normalizedSafeName, [...(byName.get(p.normalizedSafeName) ?? []), { row: p.row, sku, name }]);
  }
  return [
    ...[...bySku.entries()].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({ type: "upload_duplicate_sku" as const, key, rows: rows.map(r => r.row), sku: rows[0]?.sku ?? null, name: rows[0]?.name ?? null })),
    ...[...byName.entries()].filter(([, rows]) => rows.length > 1).map(([key, rows]) => ({ type: "upload_duplicate_name" as const, key, rows: rows.map(r => r.row), sku: rows[0]?.sku ?? null, name: rows[0]?.name ?? null })),
  ];
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
  const prepared: Array<{ row: number; rec: ImportRow; values: CatalogImportUpsertValues; updateValues: Partial<CatalogImportUpsertValues>; inventory: Record<string, number>; par: Record<string, number>; normalizedSafeName: string }> = [];
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
    const imageUrl = safeUrl(rec["Alavont Image"], "Alavont Image", rowNum, errors); const safeImageUrl = safeUrl(rec["Safe Image"], "Safe Image", rowNum, errors);
    const safeName = safeText(rec["Safe Name"] || name, "Safe Name", rowNum, errors);
    const safeDescription = safeText(rec["Safe Description"], "Safe Description", rowNum, errors) || null;
    const safeCategory = safeText(rec["Safe Category"] || category, "Safe Category", rowNum, errors) || category;
    const safeCategoryLower = `${name} ${category} ${rec["Alavont Description"]}`.toLowerCase();
    const complianceHold = /(cannabis|marijuana|weed|thc|cocaine|meth|opioid|fentanyl|psilocybin|mushroom|lsd|mdma|controlled substance|psychedelic|hallucinogen|stimulant|depressant)/i.test(safeCategoryLower);
    const totalInventory = String(Object.values(inventory).reduce((a, b) => a + b, 0).toFixed(2));
    const importValues: CatalogImportUpsertValues = { tenantId, sku, merchantSku: sku, name, description: safeText(rec["Alavont Description"], "Alavont Description", rowNum, errors) || null, category, price: checkoutPrice.toFixed(2), regularPrice: regularPrice.toFixed(2), compareAtPrice: salePrice !== null ? salePrice.toFixed(2) : null, stockUnit: "#", inventoryAmount: totalInventory, stockQuantity: totalInventory, isAvailable: !complianceHold, imageUrl, alavontName: name, alavontDescription: rec["Alavont Description"] || null, alavontCategory: category, alavontImageUrl: imageUrl, alavontInStock: !complianceHold, alavontId: sku, externalMenuId: sku, luciferCruzName: safeName, luciferCruzDescription: safeDescription, luciferCruzCategory: safeCategory, luciferCruzImageUrl: safeImageUrl, safeName, safeDescription, safeCategory, safeImageUrl, merchantName: safeName, merchantDescription: safeDescription, merchantCategory: safeCategory, merchantImage: safeImageUrl, merchantBrand: "alavont", parLevel: String(Object.values(par).reduce((a, b) => a + b, 0).toFixed(2)), isWooManaged: false, isLocalAlavont: true, receiptName: safeName, labelName: safeName, labName: sku, metadata: { activeSale, complianceHold, importTemplate: "alavont_safe_inventory_v2" } };
    const updateValues: Partial<CatalogImportUpsertValues> = {
      safeName,
      safeDescription,
      safeCategory,
      safeImageUrl,
      luciferCruzName: safeName,
      luciferCruzDescription: safeDescription,
      luciferCruzCategory: safeCategory,
      luciferCruzImageUrl: safeImageUrl,
      sku,
      merchantSku: sku,
      isAvailable: !complianceHold,
      inventoryAmount: totalInventory,
      stockQuantity: totalInventory,
      merchantName: safeName,
      merchantDescription: safeDescription,
      merchantCategory: safeCategory,
      merchantImage: safeImageUrl,
      merchantBrand: "alavont",
      updatedAt: new Date(),
    };
    prepared.push({ row: rowNum, rec, inventory, par, normalizedSafeName: normalizeProductName(safeName), values: importValues, updateValues });
  }
  const allTenantCatalog = await db.select().from(catalogItemsTable).where(eq(catalogItemsTable.tenantId, tenantId)) as Array<typeof catalogItemsTable.$inferSelect>;
  const duplicateWarnings = buildUploadDuplicateWarnings(prepared);
  const bySku = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const item of allTenantCatalog) {
    const skuKey = String(item.sku ?? item.alavontId ?? item.merchantSku ?? "").trim().toLowerCase();
    const nameKey = normalizeProductName(item.safeName ?? item.luciferCruzName ?? item.merchantName ?? item.customerSafeName ?? item.name);
    if (skuKey && !bySku.has(skuKey)) bySku.set(skuKey, item.id);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, item.id);
  }
  const preview = prepared.map(p => {
    const skuKey = String(p.values.sku ?? "").trim().toLowerCase();
    const matchedId = bySku.get(skuKey) ?? byName.get(p.normalizedSafeName) ?? null;
    return { row: p.row, oldProductId: matchedId, matchedProductId: matchedId, sku: p.values.sku, name: p.values.name, parValues: p.par, duplicateWarnings: duplicateWarnings.filter(w => w.key === skuKey || w.key === p.normalizedSafeName || w.rows.includes(p.row)) };
  });
  const matchedIds = new Set(preview.map(p => p.matchedProductId).filter((id): id is number => typeof id === "number"));
  if (duplicateWarnings.length) {
    logger.warn({ tenantId, count: duplicateWarnings.length, first10Warnings: duplicateWarnings.slice(0, 10) }, "import_duplicate_block");
    res.status(409).json({ error: duplicateImportErrorMessage(duplicateWarnings), duplicateWarnings, preview, inserted: 0, updated: 0 });
    return;
  }
  if ((matchedIds.size || !dryRun) && !confirmed && !dryRun) { res.status(409).json({ error: "Catalog import can overwrite existing catalog, inventory, and par values. Re-submit with confirm=true after reviewing the preview.", requiresConfirmation: true, preview, wouldInsert: prepared.length - matchedIds.size, wouldUpdate: matchedIds.size }); return; }
  if (dryRun || errors.length) { res.json({ dryRun: true, inserted: Math.max(0, prepared.length - matchedIds.size), updated: matchedIds.size, skipped: 0, errors, total: prepared.length, warnings: matchedIds.size ? [`${matchedIds.size} existing products would be updated.`] : [], duplicateWarnings, preview }); return; }

  try {
    const importResult = await db.transaction(async (tx: typeof db) => {
      let inserted = 0;
      let updated = 0;
      for (const p of prepared) {
        const skuKey = String(p.values.sku ?? "").trim().toLowerCase();
        const existingId = bySku.get(skuKey) ?? byName.get(p.normalizedSafeName);
        if (existingId) {
          await tx.update(catalogItemsTable).set(p.updateValues).where(and(eq(catalogItemsTable.id, existingId), eq(catalogItemsTable.tenantId, tenantId)));
          updated++;
        } else {
          await tx.insert(catalogItemsTable).values(p.values).returning({ id: catalogItemsTable.id });
          inserted++;
        }
      }
      return { inserted, updated };
    });
    await audit(req, "catalog_import", tenantId, { fileName: uploadedFileName, inserted: importResult.inserted, updated: importResult.updated, total: prepared.length });
    res.json({ inserted: importResult.inserted, updated: importResult.updated, skipped: 0, errors: [] });
  } catch (e) { res.status(500).json({ error: `Import failed before completion and no catalog changes were committed: ${(e as Error).message}` }); }
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
