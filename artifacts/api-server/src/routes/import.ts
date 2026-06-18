import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, catalogItemsTable, auditLogsTable, inventoryTemplatesTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { ensureStandardLocations, ensureAllInventoryBalances } from "../lib/inventoryBalances";
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
  "sku",
  "name",
  "description",
  "category",
  "brand",
  "price",
  "unit",
  "quantity_size",
  "active",
  "image_url",
  "safe_name",
  "safe_description",
  "safe_category",
  "safe_image_url",
  "inventory_location",
  "current_inventory",
  "par_level",
  "reorder_threshold",
  "sort_order",
] as const;
type CatalogImportHeader = (typeof CATALOG_IMPORT_HEADERS)[number];
const HEADER_SET = new Set<string>(CATALOG_IMPORT_HEADERS);
const REQUIRED_HEADERS: CatalogImportHeader[] = ["sku", "name", "category", "price"];
const DANGEROUS_CELL = /^[=+\-@\t\r]/;
const MAX_ROWS = 5000;

const LEGACY_ALIASES: Record<string, CatalogImportHeader> = {
  regular_price: "price",
  Sale_price: "price",
  alavont_name: "name",
  alavont_desc: "description",
  alavont_category: "category",
  alavont_image: "image_url",
  alavont_id: "sku",
  alavont_in_stock: "active",
  Quantity: "quantity_size",
  Unit: "unit",
  lucifer_cruz_Inventory: "sku",
  lucifer_cruz_name: "safe_name",
  lucifer_cruz_desc: "safe_description",
  lucifer_cruz_category: "safe_category",
  lucifer_cruz_image: "safe_image_url",
};

type ParsedFile = { headers: string[]; rawHeaders: string[]; rows: string[][] };
type ImportRow = Record<CatalogImportHeader, string>;

type ImportDbClient = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;

type SnapshotPayload = {
  catalog: Array<typeof catalogItemsTable.$inferSelect>;
  inventoryTemplates: Array<typeof inventoryTemplatesTable.$inferSelect>;
  touchedSkus: string[];
  insertedCatalogIds: number[];
  insertedInventoryTemplateIds: number[];
};

function cleanHeader(raw: string): string { return raw.replace(/^\uFEFF/, "").trim(); }
function canonicalizeHeader(raw: string): string {
  const cleaned = cleanHeader(raw);
  return LEGACY_ALIASES[cleaned] ?? cleaned;
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
function validateHeaders(headers: string[]) {
  const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
  const extra = headers.filter(h => !HEADER_SET.has(h));
  const duplicates = headers.filter((h, i) => headers.indexOf(h) !== i);
  return { ok: missing.length === 0 && extra.length === 0 && duplicates.length === 0, missing, extra, duplicates };
}
function parseNumber(raw: string, field: string, row: number, errors: { row: number; message: string }[], opts: { required?: boolean; min?: number } = {}): number | null {
  if (!raw.trim()) { if (opts.required) errors.push({ row, message: `${field} is required` }); return null; }
  const n = Number(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || (opts.min != null && n < opts.min)) { errors.push({ row, message: `${field} must be a valid number${opts.min != null ? ` >= ${opts.min}` : ""}` }); return null; }
  return n;
}
function parseBool(raw: string): boolean { return !["0", "false", "no", "n", "inactive"].includes(raw.trim().toLowerCase()); }
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
async function snapshotTenant(client: ImportDbClient, tenantId: number, touchedSkus: string[], fileName: string | undefined, actorId: number): Promise<number | null> {
  const catalog = await client.select().from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), sql`${catalogItemsTable.sku} = ANY(${touchedSkus})`));
  const catalogIds = catalog.map((r: typeof catalogItemsTable.$inferSelect) => r.id);
  const inventoryTemplates = (catalogIds.length ? await client.select().from(inventoryTemplatesTable).where(and(eq(inventoryTemplatesTable.tenantId, tenantId), sql`${inventoryTemplatesTable.catalogItemId} = ANY(${catalogIds})`)) : []) as Array<typeof inventoryTemplatesTable.$inferSelect>;
  const [created] = await client.execute(sql`INSERT INTO catalog_import_snapshots (tenant_id, actor_id, file_name, snapshot) VALUES (${tenantId}, ${actorId}, ${fileName ?? null}, ${JSON.stringify({ catalog, inventoryTemplates, touchedSkus, insertedCatalogIds: [], insertedInventoryTemplateIds: [] } satisfies SnapshotPayload)}::jsonb) RETURNING id`) as unknown as [{ id: number }];
  return created?.id ?? null;
}

router.get("/admin/products/import-template", requireRole("global_admin", "admin"), async (_req, res) => {
  const sample = ["SKU-001", "Sample Product", "Sample description", "Skin Care", "alavont", "29.99", "ml", "10", "true", "https://example.com/product.jpg", "Safe Sample Product", "Safe payment description", "Wellness", "https://example.com/safe.jpg", "backstock", "25", "10", "5", "10"];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="catalog_import_template.csv"');
  res.send([CATALOG_IMPORT_HEADERS.map(csvEscape).join(","), sample.map(csvEscape).join(",")].join("\n"));
});
router.get("/admin/products/import-spec", requireRole("global_admin", "admin"), (_req, res) => { res.json({ spec: { version: 1, columns: CATALOG_IMPORT_HEADERS.map(h => ({ id: h, header: h, canonical: h, required: REQUIRED_HEADERS.includes(h), sampleValue: "", locked: true })) } }); } );

router.post("/admin/products/parse-headers", requireRole("global_admin", "admin"), upload.single("file") as never, async (req, res) => {
  if (!req.file?.buffer) { res.status(400).json({ error: "No file provided" }); return; }
  try {
    const parsed = parseBuffer(req.file.buffer, req.file.originalname);
    const v = validateHeaders(parsed.headers);
    res.json({ headerMappings: parsed.headers.map((h, i) => ({ original: parsed.rawHeaders[i] ?? h, canonical: h, recognized: HEADER_SET.has(h) })), missingRequired: v.missing, unknownHeaders: v.extra, duplicateHeaders: v.duplicates, requiredFields: REQUIRED_HEADERS.map(h => ({ canonical: h, friendlyName: h, found: parsed.headers.includes(h), mappedFrom: parsed.rawHeaders[parsed.headers.indexOf(h)] ?? null })), fileColumns: parsed.rawHeaders, allCanonicals: CATALOG_IMPORT_HEADERS.map(h => ({ canonical: h, friendlyName: h, required: REQUIRED_HEADERS.includes(h) })) });
  } catch (e) { res.status(400).json({ error: `Could not parse file: ${(e as Error).message}` }); }
});

router.get("/admin/products/export", requireRole("global_admin", "admin"), async (req, res) => {
  const tenantId = await getHouseTenantId();
  const rows = await db.select().from(catalogItemsTable).where(eq(catalogItemsTable.tenantId, tenantId)) as Array<typeof catalogItemsTable.$inferSelect>;
  const catalogIds = rows.map((r: typeof catalogItemsTable.$inferSelect) => r.id);
  const templates = (catalogIds.length ? await db.select().from(inventoryTemplatesTable).where(and(eq(inventoryTemplatesTable.tenantId, tenantId), sql`${inventoryTemplatesTable.catalogItemId} = ANY(${catalogIds})`)) : []) as Array<typeof inventoryTemplatesTable.$inferSelect>;
  const byCatalog = new Map(templates.map(t => [t.catalogItemId, t]));
  const lines = [CATALOG_IMPORT_HEADERS.map(csvEscape).join(",")];
  for (const item of rows) {
    const tmpl = byCatalog.get(item.id);
    lines.push([
      item.sku ?? item.merchantSku ?? item.alavontId ?? "", item.name, item.description ?? "", item.category, item.merchantBrand ?? "alavont", item.price, item.stockUnit ?? item.unitMeasurement ?? "", item.inventoryAmount ?? item.stockQuantity ?? "", item.isAvailable !== false ? "true" : "false", item.imageUrl ?? item.alavontImageUrl ?? "", item.luciferCruzName ?? item.customerSafeName ?? item.name, item.luciferCruzDescription ?? item.customerSafeDescription ?? item.description ?? "", item.luciferCruzCategory ?? item.category, item.luciferCruzImageUrl ?? item.imageUrl ?? "", tmpl?.sectionName ?? "", tmpl?.currentStock ?? item.stockQuantity ?? "", item.parLevel ?? tmpl?.parLevel ?? "", item.parLevel ?? tmpl?.parLevel ?? "", tmpl?.displayOrder ?? "",
    ].map(csvEscape).join(","));
  }
  await audit(req, "catalog_export", tenantId, { count: rows.length });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="catalog_export.csv"');
  res.send(lines.join("\n"));
});

router.post("/admin/products/import", requireRole("global_admin", "admin"), upload.single("file") as never, async (req, res) => {
  const tenantId = await getHouseTenantId(); const actor = req.dbUser!; const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
  const uploadedFileName = req.file?.originalname;
  const confirmed = req.body?.confirm === "true" || req.body?.confirm === true || req.query.confirm === "true";
  if (!req.file?.buffer) { res.status(400).json({ error: "A CSV, TSV, or XLSX file upload is required" }); return; }
  let parsed: ParsedFile;
  try { parsed = parseBuffer(req.file.buffer, req.file.originalname); } catch (e) { res.status(400).json({ error: `Could not parse file: ${(e as Error).message}` }); return; }
  if (parsed.rows.length > MAX_ROWS) { res.status(413).json({ error: `Import is limited to ${MAX_ROWS} data rows` }); return; }
  const v = validateHeaders(parsed.headers);
  if (v.missing.length) { res.status(400).json({ error: `Missing required column(s): ${v.missing.join(", ")}`, missingColumns: v.missing }); return; }
  if (v.extra.length) { res.status(400).json({ error: `Unexpected column(s): ${v.extra.join(", ")}`, extraColumns: v.extra }); return; }
  if (v.duplicates.length) { res.status(400).json({ error: `Duplicate column(s): ${Array.from(new Set(v.duplicates)).join(", ")}`, duplicateColumns: v.duplicates }); return; }

  const errors: { row: number; message: string }[] = []; const prepared: Array<{ rec: ImportRow; values: typeof catalogItemsTable.$inferInsert; currentInventory: number | null; sortOrder: number | null; parLevel: number | null }> = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const rowNum = i + 2; const rec = buildRecord(parsed.rows[i], parsed.headers);
    const sku = safeText(rec.sku, "sku", rowNum, errors, true); const name = safeText(rec.name, "name", rowNum, errors, true); const category = safeText(rec.category, "category", rowNum, errors, true);
    const price = parseNumber(rec.price, "price", rowNum, errors, { required: true, min: 0 });
    const quantity = parseNumber(rec.quantity_size, "quantity_size", rowNum, errors, { min: 0 }); const currentInventory = parseNumber(rec.current_inventory, "current_inventory", rowNum, errors, { min: 0 }); const parLevel = parseNumber(rec.par_level, "par_level", rowNum, errors, { min: 0 }); const sortOrder = parseNumber(rec.sort_order, "sort_order", rowNum, errors, { min: 0 });
    if (!sku || !name || !category || price === null) continue;
    const imageUrl = safeUrl(rec.image_url, "image_url", rowNum, errors); const safeImageUrl = safeUrl(rec.safe_image_url, "safe_image_url", rowNum, errors);
    prepared.push({ rec, currentInventory, sortOrder, parLevel, values: { tenantId, sku, merchantSku: sku, name, description: safeText(rec.description, "description", rowNum, errors) || null, category, price: price.toFixed(2), regularPrice: price.toFixed(2), stockUnit: safeText(rec.unit, "unit", rowNum, errors) || null, inventoryAmount: quantity !== null ? quantity.toFixed(2) : null, stockQuantity: currentInventory !== null ? currentInventory.toFixed(2) : quantity !== null ? quantity.toFixed(2) : "0", isAvailable: rec.active ? parseBool(rec.active) : true, imageUrl, alavontName: name, alavontDescription: rec.description || null, alavontCategory: category, alavontImageUrl: imageUrl, alavontInStock: rec.active ? parseBool(rec.active) : true, alavontId: sku, externalMenuId: sku, luciferCruzName: safeText(rec.safe_name || rec.name, "safe_name", rowNum, errors), luciferCruzDescription: safeText(rec.safe_description, "safe_description", rowNum, errors) || null, luciferCruzCategory: safeText(rec.safe_category || rec.category, "safe_category", rowNum, errors) || null, luciferCruzImageUrl: safeImageUrl, merchantName: rec.safe_name || name, merchantDescription: rec.safe_description || null, merchantCategory: rec.safe_category || category, merchantImage: safeImageUrl, merchantBrand: rec.brand || "alavont", parLevel: parLevel !== null ? parLevel.toFixed(2) : "0", isWooManaged: false, isLocalAlavont: true, receiptName: rec.safe_name || name, labelName: rec.safe_name || name, labName: sku } });
  }
  const skus = prepared.map(p => p.values.sku).filter(Boolean) as string[];
  const existing = (skus.length ? await db.select({ id: catalogItemsTable.id, sku: catalogItemsTable.sku }).from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), sql`${catalogItemsTable.sku} = ANY(${skus})`)) : []) as Array<{ id: number; sku: string | null }>;
  if ((existing.length || !dryRun) && !confirmed && !dryRun) { res.status(409).json({ error: "Catalog import can overwrite existing catalog, inventory, and par values. Re-submit with confirm=true after reviewing the preview.", requiresConfirmation: true, wouldInsert: prepared.length - existing.length, wouldUpdate: existing.length }); return; }
  if (dryRun || errors.length) { res.json({ dryRun: true, inserted: Math.max(0, prepared.length - existing.length), updated: existing.length, skipped: 0, errors, total: prepared.length, warnings: existing.length ? [`${existing.length} existing products would be updated.`] : [] }); return; }

  let snapshotId: number | null = null;
  try {
    await ensureSnapshotSchema();
    const importResult = await db.transaction(async (tx) => {
      let inserted = 0;
      let updated = 0;
      const insertedIds: number[] = [];
      const insertedInventoryTemplateIds: number[] = [];
      const createdSnapshotId = await snapshotTenant(tx, tenantId, skus, uploadedFileName, actor.id);
      const bySku = new Map(existing.map(e => [e.sku, e.id]));
      for (const p of prepared) {
        const existingId = bySku.get(p.values.sku ?? "");
        let catalogId = existingId;
        if (existingId) { await tx.update(catalogItemsTable).set(p.values).where(and(eq(catalogItemsTable.id, existingId), eq(catalogItemsTable.tenantId, tenantId))); updated++; }
        else { const [created] = await tx.insert(catalogItemsTable).values(p.values).returning({ id: catalogItemsTable.id }); catalogId = created.id; insertedIds.push(created.id); inserted++; }
        const [tmpl] = await tx.select({ id: inventoryTemplatesTable.id }).from(inventoryTemplatesTable).where(and(eq(inventoryTemplatesTable.tenantId, tenantId), eq(inventoryTemplatesTable.catalogItemId, catalogId!))).limit(1);
        const patch = { itemName: p.values.name, sectionName: p.rec.inventory_location || null, unitType: p.values.stockUnit ?? "#", startingQuantityDefault: p.values.stockQuantity ?? "0", currentStock: p.currentInventory !== null ? p.currentInventory.toFixed(3) : p.values.stockQuantity ?? "0", menuPrice: p.values.price, payoutPrice: p.values.price, isActive: p.values.isAvailable, catalogItemId: catalogId!, alavontId: p.values.alavontId, deductionQuantityPerSale: "1", parLevel: p.parLevel !== null ? p.parLevel.toFixed(2) : "0" };
        if (tmpl) await tx.update(inventoryTemplatesTable).set(patch).where(and(eq(inventoryTemplatesTable.id, tmpl.id), eq(inventoryTemplatesTable.tenantId, tenantId)));
        else { const [createdTemplate] = await tx.insert(inventoryTemplatesTable).values({ tenantId, displayOrder: p.sortOrder ?? 0, ...patch }).returning({ id: inventoryTemplatesTable.id }); insertedInventoryTemplateIds.push(createdTemplate.id); }
      }
      await tx.execute(sql`UPDATE catalog_import_snapshots SET snapshot = jsonb_set(jsonb_set(snapshot, '{insertedCatalogIds}', ${JSON.stringify(insertedIds)}::jsonb), '{insertedInventoryTemplateIds}', ${JSON.stringify(insertedInventoryTemplateIds)}::jsonb) WHERE id = ${createdSnapshotId}`);
      return { inserted, updated, snapshotId: createdSnapshotId };
    });
    snapshotId = importResult.snapshotId;
    await ensureStandardLocations(tenantId); const inventoryBalances = await ensureAllInventoryBalances(tenantId);
    await audit(req, "catalog_import", tenantId, { fileName: uploadedFileName, inserted: importResult.inserted, updated: importResult.updated, snapshotId, total: prepared.length });
    res.json({ inserted: importResult.inserted, updated: importResult.updated, skipped: 0, errors: [], snapshotId, inventoryBalances });
  } catch (e) { res.status(500).json({ error: `Import failed before completion and no catalog/inventory changes were committed: ${(e as Error).message}`, snapshotId }); }
});

router.post("/admin/products/import/rollback", requireRole("global_admin", "admin"), async (req, res) => {
  const tenantId = await getHouseTenantId(); await ensureSnapshotSchema();
  const [snapshotRow] = await db.execute(sql`SELECT id, snapshot FROM catalog_import_snapshots WHERE tenant_id = ${tenantId} AND rolled_back_at IS NULL ORDER BY created_at DESC LIMIT 1`) as unknown as Array<{ id: number; snapshot: SnapshotPayload }>;
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
router.post("/admin/import/catalog", requireRole("global_admin", "admin"), upload.single("file") as never, (_req, res) => { res.redirect(307, "/api/admin/products/import"); });

export default router;
