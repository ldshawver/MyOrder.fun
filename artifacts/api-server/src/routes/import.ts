import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, catalogItemsTable, auditLogsTable, adminSettingsTable, inventoryTemplatesTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import multer from "multer";
import * as XLSX from "xlsx";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(csv|tsv|xlsx|xls)$/i.test(file.originalname) ||
      file.mimetype === "text/csv" ||
      file.mimetype === "text/tab-separated-values" ||
      file.mimetype === "text/plain" ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel";
    cb(null, ok);
  },
});

// ─── Canonical Alavont menu import headers ───────────────────────────────────
// The downloadable template uses these canonical names. For backwards
// compatibility, the importer also accepts the older friendly "Menu ..." /
// "Merchant ..." column labels and maps them to the same canonical fields.
export const EXPECTED_HEADERS = [
  "regular_price",
  "alavont_image",
  "alavont_name",
  "alavont_desc",
  "alavont_category",
  "alavont_in_stock",
  "alavont_id",
  "Quantity",
  "Unit",
  "lucifer_cruz_name",
  "lucifer_cruz_image",
  "lucifer_cruz_desc",
  "lucifer_cruz_category",
  "lucifer_cruz_Inventory",
] as const;

export type ExpectedHeader = (typeof EXPECTED_HEADERS)[number];

const OPTIONAL_HEADERS = ["Sale_price"] as const;
const ALL_CANONICAL_HEADERS = [...EXPECTED_HEADERS, ...OPTIONAL_HEADERS] as const;
type OptionalHeader = (typeof OPTIONAL_HEADERS)[number];
type ImportCanonical = ExpectedHeader | OptionalHeader;
type ImportTemplateColumn = {
  id: string;
  header: string;
  canonical: ImportCanonical | `custom:${string}`;
  required: boolean;
  sampleValue: string;
  locked?: boolean;
};
type ImportTemplateSpec = {
  version: 1;
  columns: ImportTemplateColumn[];
};

// Canonical header → record field name
export const HEADER_TO_FIELD: Record<ExpectedHeader, string> = {
  "regular_price": "regularPrice",
  "alavont_image": "alavontImage",
  "alavont_name": "alavontName",
  "alavont_desc": "alavontDesc",
  "alavont_category": "alavontCategory",
  "alavont_in_stock": "alavontInStock",
  "alavont_id": "alavontId",
  "Quantity": "quantity",
  "Unit": "unit",
  "lucifer_cruz_name": "luciferCruzName",
  "lucifer_cruz_image": "luciferCruzImage",
  "lucifer_cruz_desc": "luciferCruzDesc",
  "lucifer_cruz_category": "luciferCruzCategory",
  "lucifer_cruz_Inventory": "luciferCruzInventory",
};

const EXPECTED_SET = new Set<string>(EXPECTED_HEADERS);
const KNOWN_CANONICAL_SET = new Set<string>(ALL_CANONICAL_HEADERS);

const HEADER_ALIASES: Record<string, ExpectedHeader | (typeof OPTIONAL_HEADERS)[number]> = {
  "Menu Regular Price": "regular_price",
  "Menu Image": "alavont_image",
  "Menu Name": "alavont_name",
  "Menu Description": "alavont_desc",
  "Menu Category": "alavont_category",
  "Menu In Stock": "alavont_in_stock",
  "Menu ID": "alavont_id",
  "Amount": "Quantity",
  "Unit Measurement": "Unit",
  "Merchant Name": "lucifer_cruz_name",
  "Merchant Image": "lucifer_cruz_image",
  "Merchant Description": "lucifer_cruz_desc",
  "Merchant Category": "lucifer_cruz_category",
  "Merchant Sku": "lucifer_cruz_Inventory",
};

const DEFAULT_IMPORT_COLUMNS: ImportTemplateColumn[] = [
  { id: "regular-price", canonical: "regular_price", header: "regular_price", required: true, sampleValue: "29.99", locked: true },
  { id: "alavont-image", canonical: "alavont_image", header: "alavont_image", required: true, sampleValue: "https://example.com/alavont.jpg", locked: true },
  { id: "alavont-name", canonical: "alavont_name", header: "alavont_name", required: true, sampleValue: "Midnight Recovery Complex", locked: true },
  { id: "alavont-desc", canonical: "alavont_desc", header: "alavont_desc", required: true, sampleValue: "Advanced cellular recovery blend", locked: true },
  { id: "alavont-category", canonical: "alavont_category", header: "alavont_category", required: true, sampleValue: "Dermatology", locked: true },
  { id: "alavont-in-stock", canonical: "alavont_in_stock", header: "alavont_in_stock", required: true, sampleValue: "true", locked: true },
  { id: "alavont-id", canonical: "alavont_id", header: "alavont_id", required: true, sampleValue: "ALV-001", locked: true },
  { id: "quantity", canonical: "Quantity", header: "Quantity", required: true, sampleValue: "10", locked: true },
  { id: "unit", canonical: "Unit", header: "Unit", required: true, sampleValue: "ml", locked: true },
  { id: "sale-price", canonical: "Sale_price", header: "Sale_price", required: false, sampleValue: "", locked: false },
  { id: "lucifer-cruz-name", canonical: "lucifer_cruz_name", header: "lucifer_cruz_name", required: true, sampleValue: "Velvet Restore Set", locked: true },
  { id: "lucifer-cruz-image", canonical: "lucifer_cruz_image", header: "lucifer_cruz_image", required: true, sampleValue: "https://example.com/lc.jpg", locked: true },
  { id: "lucifer-cruz-desc", canonical: "lucifer_cruz_desc", header: "lucifer_cruz_desc", required: true, sampleValue: "Luxurious overnight treatment", locked: true },
  { id: "lucifer-cruz-category", canonical: "lucifer_cruz_category", header: "lucifer_cruz_category", required: true, sampleValue: "Skin Care", locked: true },
  { id: "lucifer-cruz-inventory", canonical: "lucifer_cruz_Inventory", header: "lucifer_cruz_Inventory", required: true, sampleValue: "MRC-LAB-001", locked: true },
];

const DEFAULT_IMPORT_SPEC: ImportTemplateSpec = { version: 1, columns: DEFAULT_IMPORT_COLUMNS };
let importTemplateColumnEnsured = false;
let catalogImportSchemaEnsured = false;

// ─── Header normalization (BOM / whitespace strip only — case-sensitive) ──────
function cleanHeader(raw: string): string {
  return raw.replace(/^\uFEFF/, "").trim();
}

function canonicalizeHeader(raw: string, spec = DEFAULT_IMPORT_SPEC): string {
  const cleaned = cleanHeader(raw);
  const configured = spec.columns.find(c => c.header === cleaned);
  if (configured) return configured.canonical;
  return HEADER_ALIASES[cleaned] ?? cleaned;
}

function normalizeCustomCanonical(header: string, existing: Set<string>): `custom:${string}` {
  const base = cleanHeader(header)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "column";
  let candidate = `custom:${base}` as `custom:${string}`;
  let i = 2;
  while (existing.has(candidate)) {
    candidate = `custom:${base}_${i}` as `custom:${string}`;
    i++;
  }
  return candidate;
}

function isKnownCanonical(value: string): value is ImportCanonical {
  return KNOWN_CANONICAL_SET.has(value);
}

function normalizeImportSpec(input: unknown): ImportTemplateSpec {
  const rawColumns = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as { columns?: unknown }).columns
    : null;
  const incoming = Array.isArray(rawColumns) ? rawColumns : DEFAULT_IMPORT_COLUMNS;
  const columns: ImportTemplateColumn[] = [];
  const seenCanonicals = new Set<string>();
  const seenHeaders = new Set<string>();

  for (const raw of incoming) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const header = cleanHeader(String(item.header ?? ""));
    if (!header || seenHeaders.has(header)) continue;
    const canonicalRaw = typeof item.canonical === "string" ? item.canonical : "";
    const isKnown = isKnownCanonical(canonicalRaw);
    const canonical = isKnown
      ? canonicalRaw
      : normalizeCustomCanonical(header, seenCanonicals);

    if (seenCanonicals.has(canonical)) continue;
    seenCanonicals.add(canonical);
    seenHeaders.add(header);
    const required = EXPECTED_SET.has(canonical);
    columns.push({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : String(canonical).replace(/[^a-zA-Z0-9_-]/g, "-"),
      header,
      canonical,
      required,
      sampleValue: typeof item.sampleValue === "string" ? item.sampleValue : "",
      locked: required,
    });
  }

  for (const defaultColumn of DEFAULT_IMPORT_COLUMNS) {
    if (!EXPECTED_SET.has(defaultColumn.canonical) || seenCanonicals.has(defaultColumn.canonical)) continue;
    columns.push(defaultColumn);
    seenCanonicals.add(defaultColumn.canonical);
  }

  return { version: 1, columns };
}

function validateImportSpec(input: unknown): { ok: true; spec: ImportTemplateSpec } | { ok: false; error: string } {
  const rawColumns = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as { columns?: unknown }).columns
    : null;
  if (!Array.isArray(rawColumns)) {
    return { ok: false, error: "columns must be an array" };
  }
  const spec = normalizeImportSpec(input);
  const headers = spec.columns.map(c => c.header);
  if (new Set(headers).size !== headers.length) {
    return { ok: false, error: "Header labels must be unique" };
  }
  const present = new Set(spec.columns.map(c => c.canonical));
  const missing = EXPECTED_HEADERS.filter(c => !present.has(c));
  if (missing.length > 0) {
    return { ok: false, error: `Required backend fields cannot be removed: ${missing.join(", ")}` };
  }
  if (spec.columns.length > 60) {
    return { ok: false, error: "Import template cannot exceed 60 columns" };
  }
  return { ok: true, spec };
}

async function getOrCreateSettingsRow() {
  if (!importTemplateColumnEnsured) {
    await db.execute(sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "import_template_spec" text`);
    importTemplateColumnEnsured = true;
  }
  const [existing] = await db
    .select({
      id: adminSettingsTable.id,
      tenantId: adminSettingsTable.tenantId,
      importTemplateSpec: adminSettingsTable.importTemplateSpec,
    })
    .from(adminSettingsTable)
    .limit(1);
  if (existing) return existing;
  const tenantId = await getHouseTenantId();
  const [created] = await db.insert(adminSettingsTable).values({ tenantId }).returning();
  return created;
}

async function loadImportSpec(): Promise<ImportTemplateSpec> {
  const settings = await getOrCreateSettingsRow();
  if (!settings.importTemplateSpec) return DEFAULT_IMPORT_SPEC;
  try {
    return normalizeImportSpec(JSON.parse(settings.importTemplateSpec));
  } catch {
    return DEFAULT_IMPORT_SPEC;
  }
}

function specRecognizedSet(spec: ImportTemplateSpec): Set<string> {
  return new Set(spec.columns.map(c => c.canonical));
}

async function ensureCatalogImportSchema(): Promise<void> {
  if (catalogImportSchemaEnsured) return;
  const statements = [
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "external_menu_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "inventory_amount" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "unit_measurement" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_image" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_sku" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_brand" text NOT NULL DEFAULT 'alavont'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "internal_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "internal_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "internal_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "supplier_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "supplier_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "backend_inventory_notes" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "vendor_sku" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "source_inventory_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "cost_basis" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "inventory_tracking_data" jsonb DEFAULT '{}'::jsonb`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_image" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_brand_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "marketing_copy" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "upsell_copy" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "promo_badges" text[] DEFAULT ARRAY[]::text[]`,
  ];
  for (const statement of statements) {
    await db.execute(statement);
  }
  catalogImportSchemaEnsured = true;
}

async function ensureInventoryTemplateSchema(): Promise<void> {
  const statements = [
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "catalog_item_id" integer`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "alavont_id" text`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "deduction_unit_output" text DEFAULT '#'`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "deduction_quantity_per_sale" numeric(10, 3) DEFAULT 1`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "menu_price" numeric(10, 2)`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "payout_price" numeric(10, 2)`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "current_stock" numeric(10, 3)`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "par_level" numeric(10, 2) DEFAULT 0`,
  ];
  for (const statement of statements) {
    await db.execute(statement);
  }
}

async function syncImportedCatalogToInventoryTemplates(tenantId: number): Promise<{ inserted: number; updated: number }> {
  await ensureInventoryTemplateSchema();

  const catalogRows = await db
    .select()
    .from(catalogItemsTable)
    .where(
      and(
        eq(catalogItemsTable.tenantId, tenantId),
        eq(catalogItemsTable.isWooManaged, false),
        eq(catalogItemsTable.isLocalAlavont, true),
      )
    );

  const templateRows = await db
    .select()
    .from(inventoryTemplatesTable)
    .where(eq(inventoryTemplatesTable.tenantId, tenantId));

  const byCatalogId = new Map(
    templateRows
      .filter(row => typeof row.catalogItemId === "number")
      .map(row => [row.catalogItemId as number, row])
  );
  const byAlavontId = new Map(
    templateRows
      .filter(row => row.alavontId)
      .map(row => [row.alavontId as string, row])
  );

  let inserted = 0;
  let updated = 0;
  let nextDisplayOrder = templateRows.reduce((max, row) => Math.max(max, row.displayOrder ?? 0), 0);

  for (const item of catalogRows) {
    const existing = byCatalogId.get(item.id) ?? (item.alavontId ? byAlavontId.get(item.alavontId) : undefined);
    const stockValue = item.stockQuantity ?? item.inventoryAmount ?? "0";
    const itemName = item.alavontName ?? item.displayName ?? item.name;
    const patch = {
      sectionName: item.alavontCategory ?? item.category ?? "Alavont",
      itemName,
      rowType: "item",
      unitType: item.stockUnit ?? item.unitMeasurement ?? "#",
      startingQuantityDefault: String(stockValue ?? "0"),
      currentStock: String(stockValue ?? "0"),
      menuPrice: String(item.price ?? "0"),
      payoutPrice: String(item.costBasis ?? item.price ?? "0"),
      isActive: item.isAvailable !== false,
      catalogItemId: item.id,
      alavontId: item.alavontId ?? item.externalMenuId ?? null,
      deductionQuantityPerSale: "1",
      parLevel: String(item.parLevel ?? "0"),
    };

    if (existing) {
      await db
        .update(inventoryTemplatesTable)
        .set(patch)
        .where(eq(inventoryTemplatesTable.id, existing.id));
      updated++;
    } else {
      nextDisplayOrder += 10;
      await db.insert(inventoryTemplatesTable).values({
        tenantId,
        displayOrder: nextDisplayOrder,
        ...patch,
      });
      inserted++;
    }
  }

  return { inserted, updated };
}

function formatDatabaseError(err: unknown): string {
  const e = err as {
    message?: string;
    cause?: { message?: string; detail?: string; constraint?: string; code?: string };
  };
  const cause = e.cause;
  const parts = [
    cause?.message,
    cause?.detail,
    cause?.constraint ? `constraint: ${cause.constraint}` : null,
    cause?.code ? `code: ${cause.code}` : null,
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(" — ");
  return e.message?.split("\n")[0] ?? "unknown database error";
}

// ─── Delimited (CSV / TSV) parser ─────────────────────────────────────────────
function parseDelimitedLine(line: string, delim: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === delim && !inQuote) {
      result.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result.map(s => s.trim());
}

type ParsedFile = {
  headers: string[];          // cleaned (BOM/whitespace stripped)
  rawHeaders: string[];       // as appeared in file
  rows: string[][];           // values aligned with headers
};

function parseBuffer(buffer: Buffer, originalName: string, spec = DEFAULT_IMPORT_SPEC): ParsedFile {
  const ext = originalName.split(".").pop()?.toLowerCase() ?? "csv";

  if (ext === "xlsx" || ext === "xls") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (data.length < 1) return { headers: [], rawHeaders: [], rows: [] };
    const rawHeaders = (data[0] as unknown[]).map(String);
    const rows = (data.slice(1) as unknown[][]).map(r => r.map(v => String(v ?? "")));
    return {
      headers: rawHeaders.map(h => canonicalizeHeader(h, spec)),
      rawHeaders,
      rows,
    };
  }

  // CSV / TSV — strip BOM up front, normalize line endings
  const text = buffer.toString("utf-8").replace(/^\uFEFF/, "");
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  // Drop trailing blank lines (but keep blank lines in middle as empty rows? spec doesn't say — drop)
  const nonBlank = lines.filter(l => l.trim().length > 0);
  if (nonBlank.length < 1) return { headers: [], rawHeaders: [], rows: [] };

  const firstLine = nonBlank[0];
  // Choose delimiter: explicit by extension, otherwise auto-detect (tab beats comma)
  let delim = ",";
  if (ext === "tsv") delim = "\t";
  else if (firstLine.includes("\t") && !firstLine.includes(",")) delim = "\t";

  const rawHeaders = parseDelimitedLine(firstLine, delim);
  const rows = nonBlank.slice(1).map(l => parseDelimitedLine(l, delim));
  return {
    headers: rawHeaders.map(h => canonicalizeHeader(h, spec)),
    rawHeaders,
    rows,
  };
}

// ─── Coercers ─────────────────────────────────────────────────────────────────
function parseTruthy(v: string): boolean {
  return ["1", "true", "yes", "y"].includes(v.trim().toLowerCase());
}

function parsePrice(raw: string): number | null {
  if (!raw?.trim()) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseAmount(raw: string): number | null {
  if (!raw?.trim()) return null;
  const n = parseFloat(raw.replace(/[,\s]/g, ""));
  return isNaN(n) ? null : n;
}

function isValidUrl(s: string): boolean {
  try { new URL(s); return true; } catch { return false; }
}

// ─── Header validation ────────────────────────────────────────────────────────
type HeaderValidation = {
  ok: boolean;
  missing: string[];   // expected headers not present
  extra: string[];     // present headers not in expected set (cleaned form)
};

function validateHeaders(headers: string[], spec: ImportTemplateSpec): HeaderValidation {
  const present = new Set(headers);
  const missing = EXPECTED_HEADERS.filter(h => !present.has(h));
  const recognized = specRecognizedSet(spec);
  const extra = headers.filter(h => !recognized.has(h));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

function parseUserMapping(raw: unknown, spec: ImportTemplateSpec): Record<string, string> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [original, canonical] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof original === "string" && typeof canonical === "string") {
        out[cleanHeader(original)] = canonicalizeHeader(canonical, spec);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function applyUserMapping(headers: string[], rawHeaders: string[], userMapping: Record<string, string>): string[] {
  if (Object.keys(userMapping).length === 0) return headers;
  return headers.map((canonical, i) => {
    const raw = cleanHeader(rawHeaders[i] ?? canonical);
    return userMapping[raw] ?? canonical;
  });
}

// ─── GET /api/admin/products/import-template ──────────────────────────────────
router.get(
  "/admin/products/import-spec",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    const spec = await loadImportSpec();
    res.json({ spec, defaultSpec: DEFAULT_IMPORT_SPEC });
  }
);

router.put(
  "/admin/products/import-spec",
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const validation = validateImportSpec(req.body?.spec ?? req.body);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const settings = await getOrCreateSettingsRow();
    await db.update(adminSettingsTable)
      .set({ importTemplateSpec: JSON.stringify(validation.spec) })
      .where(eq(adminSettingsTable.id, settings.id));
    res.json({ spec: validation.spec });
  }
);

router.get(
  "/admin/products/import-template",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    const spec = await loadImportSpec();
    const headers = spec.columns.map(c => c.header);
    const sampleRow = spec.columns.map(c => c.sampleValue ?? "");
    const csv = [headers.join(","), sampleRow.join(",")].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="menu_import_template.csv"');
    res.send(csv);
  }
);

// ─── POST /api/admin/products/parse-headers ───────────────────────────────────
// Inspect a file's headers without importing — used by the UI to preview
// which expected columns are present and which are missing/extra.
router.post(
  "/admin/products/parse-headers",
  requireRole("global_admin", "admin"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upload.single("file") as any,
  async (req, res): Promise<void> => {
    if (!req.file?.buffer) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    const spec = await loadImportSpec();
    let parsed: ParsedFile;
    try {
      parsed = parseBuffer(req.file.buffer, req.file.originalname, spec);
    } catch (e) {
      res.status(400).json({ error: `Could not parse file: ${(e as Error)?.message ?? "unknown"}` });
      return;
    }

    const { headers, rawHeaders } = parsed;
    const v = validateHeaders(headers, spec);
    const recognized = specRecognizedSet(spec);
    const specByCanonical = new Map(spec.columns.map(c => [c.canonical, c]));

    // Provide a structured view tailored to the existing UI.
    const headerMappings = headers.map((h, i) => ({
      original: rawHeaders[i] ?? h,
      canonical: h,
      recognized: recognized.has(h),
    }));

    res.json({
      headerMappings,
      missingRequired: v.missing,
      unknownHeaders: v.extra,
      requiredFields: EXPECTED_HEADERS.map(h => ({
        canonical: h,
        friendlyName: specByCanonical.get(h)?.header ?? h,
        found: !v.missing.includes(h),
        mappedFrom: headers.includes(h) ? (rawHeaders[headers.indexOf(h)] ?? h) : null,
      })),
      allCanonicals: spec.columns.map(c => ({
        canonical: c.canonical,
        friendlyName: c.header,
        required: c.required,
      })),
      fileColumns: rawHeaders,
      spec,
    });
  }
);

// ─── Row → record mapping ─────────────────────────────────────────────────────
type RowRecord = {
  regularPrice: string;
  alavontImage: string;
  alavontName: string;
  alavontDesc: string;
  alavontCategory: string;
  alavontInStock: string;
  alavontId: string;
  quantity: string;
  unit: string;
  luciferCruzName: string;
  luciferCruzImage: string;
  luciferCruzDesc: string;
  luciferCruzCategory: string;
  luciferCruzInventory: string;
};

function buildRecord(row: string[], headerIndex: Record<string, number>): RowRecord {
  const get = (h: ExpectedHeader): string => {
    const idx = headerIndex[h];
    if (idx === undefined) return "";
    return (row[idx] ?? "").trim();
  };
  return {
    regularPrice:        get("regular_price"),
    alavontImage:        get("alavont_image"),
    alavontName:         get("alavont_name"),
    alavontDesc:         get("alavont_desc"),
    alavontCategory:     get("alavont_category"),
    alavontInStock:      get("alavont_in_stock"),
    alavontId:           get("alavont_id"),
    quantity:            get("Quantity"),
    unit:                get("Unit"),
    luciferCruzName:     get("lucifer_cruz_name"),
    luciferCruzImage:    get("lucifer_cruz_image"),
    luciferCruzDesc:     get("lucifer_cruz_desc"),
    luciferCruzCategory: get("lucifer_cruz_category"),
    luciferCruzInventory:get("lucifer_cruz_Inventory"),
  };
}

// ─── POST /api/admin/products/import ──────────────────────────────────────────
router.post(
  "/admin/products/import",
  requireRole("global_admin", "admin"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upload.single("file") as any,
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const houseTenantId = await getHouseTenantId();
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

    if (!req.file?.buffer) {
      res.status(400).json({ error: "A file upload is required (CSV or TSV)" });
      return;
    }

    const spec = await loadImportSpec();
    let parsed: ParsedFile;
    try {
      parsed = parseBuffer(req.file.buffer, req.file.originalname, spec);
    } catch (e) {
      res.status(400).json({ error: `Could not parse file: ${(e as Error)?.message ?? "unknown"}` });
      return;
    }

    const { rows } = parsed;
    const headers = applyUserMapping(parsed.headers, parsed.rawHeaders, parseUserMapping(req.body?.userMapping, spec));
    const v = validateHeaders(headers, spec);

    if (v.missing.length > 0) {
      res.status(400).json({
        error: `Missing required column(s): ${v.missing.join(", ")}`,
        missingColumns: v.missing,
      });
      return;
    }
    if (v.extra.length > 0) {
      res.status(400).json({
        error: `Unexpected column(s): ${v.extra.join(", ")}`,
        extraColumns: v.extra,
      });
      return;
    }

    try {
      await ensureCatalogImportSchema();
    } catch (err) {
      res.status(500).json({ error: `Could not prepare catalog import schema: ${formatDatabaseError(err)}` });
      return;
    }

    // Header → column index lookup
    const headerIndex: Record<string, number> = {};
    headers.forEach((h, i) => { headerIndex[h] = i; });

    let inserted = 0, updated = 0;
    const skipped = 0;
    const errors: { row: number; message: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2; // header is row 1
      const rec = buildRecord(rows[i], headerIndex);

      // ── Required-value checks ──
      if (!rec.alavontName) {
        errors.push({ row: rowNum, message: "Menu Name is required" });
        continue;
      }
      if (!rec.alavontCategory) {
        errors.push({ row: rowNum, message: "Menu Category is required" });
        continue;
      }
      const regularPrice = parsePrice(rec.regularPrice);
      if (regularPrice === null) {
        errors.push({ row: rowNum, message: `Menu Regular Price must be numeric (got "${rec.regularPrice}")` });
        continue;
      }
      if (!rec.luciferCruzInventory && !rec.alavontId) {
        errors.push({ row: rowNum, message: "Either Merchant Sku or Menu ID is required" });
        continue;
      }

      // ── Optional/coerced values ──
      const inStock = rec.alavontInStock ? parseTruthy(rec.alavontInStock) : true;
      const amount = parseAmount(rec.quantity);
      const alavontImageUrl = rec.alavontImage && isValidUrl(rec.alavontImage) ? rec.alavontImage : null;
      const lcImageUrl = rec.luciferCruzImage && isValidUrl(rec.luciferCruzImage) ? rec.luciferCruzImage : null;
      const lcName = rec.luciferCruzName || rec.alavontName;

      // Build values for insert/update.
      // alavont_* columns drive the customer-facing catalog;
      // lucifer_cruz_* columns drive the merchant/payment side.
      const values: typeof catalogItemsTable.$inferInsert = {
        tenantId: houseTenantId,
        // Legacy generic fields (mirrored from alavont fields)
        name: rec.alavontName,
        description: rec.alavontDesc || null,
        category: rec.alavontCategory,
        sku: rec.luciferCruzInventory || null,
        price: regularPrice.toFixed(2),
        regularPrice: regularPrice.toFixed(2),
        isAvailable: inStock,
        imageUrl: alavontImageUrl,
        // Alavont-facing fields
        alavontName: rec.alavontName,
        alavontDescription: rec.alavontDesc || null,
        alavontCategory: rec.alavontCategory,
        alavontImageUrl,
        alavontInStock: inStock,
        alavontId: rec.alavontId || null,
        externalMenuId: rec.alavontId || null,
        // Quantity / unit
        inventoryAmount: amount !== null ? amount.toFixed(2) : null,
        unitMeasurement: rec.unit || null,
        // Lucifer Cruz-facing fields
        luciferCruzName: lcName,
        luciferCruzImageUrl: lcImageUrl,
        luciferCruzDescription: rec.luciferCruzDesc || null,
        luciferCruzCategory: rec.luciferCruzCategory || null,
        // Merchant mirrors
        merchantName: lcName,
        merchantImage: lcImageUrl,
        merchantDescription: rec.luciferCruzDesc || null,
        merchantCategory: rec.luciferCruzCategory || null,
        merchantSku: rec.luciferCruzInventory || null,
        merchantBrand: "alavont",
        merchantProcessingMode: "mapped_lucifer",
        merchantProductSource: "local_mapped",
        isWooManaged: false,
        isLocalAlavont: true,
        // Print names
        receiptName: lcName,
        labelName: lcName,
        labName: rec.luciferCruzInventory || null,
      };

      if (dryRun) {
        inserted++;
        continue;
      }

      try {
        // Upsert key: (tenantId, sku) if lucifer_cruz_Inventory present,
        // else (tenantId, externalMenuId) if alavont_id present
        let existingId: number | undefined;
        if (rec.luciferCruzInventory) {
          const [existing] = await db
            .select({ id: catalogItemsTable.id })
            .from(catalogItemsTable)
            .where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.sku, rec.luciferCruzInventory)))
            .limit(1);
          existingId = existing?.id;
        } else if (rec.alavontId) {
          const [existing] = await db
            .select({ id: catalogItemsTable.id })
            .from(catalogItemsTable)
            .where(and(
              eq(catalogItemsTable.tenantId, houseTenantId),
              eq(catalogItemsTable.externalMenuId, rec.alavontId),
            ))
            .limit(1);
          existingId = existing?.id;
        }

        if (existingId) {
          await db.update(catalogItemsTable).set(values).where(eq(catalogItemsTable.id, existingId));
          updated++;
        } else {
          await db.insert(catalogItemsTable).values(values);
          inserted++;
        }
      } catch (err) {
        errors.push({ row: rowNum, message: `database error — ${formatDatabaseError(err)}` });
      }
    }

    let inventoryTemplates = { inserted: 0, updated: 0 };

    if (!dryRun) {
      try {
        inventoryTemplates = await syncImportedCatalogToInventoryTemplates(houseTenantId);
      } catch (err) {
        errors.push({ row: 0, message: `inventory template sync failed — ${formatDatabaseError(err)}` });
      }

      try {
        await db.insert(auditLogsTable).values({
          actorId: actor.id,
          actorEmail: actor.email ?? "",
          actorRole: actor.role,
          action: "menu_import",
          resourceType: "catalog_item",
          metadata: {
            fileName: req.file.originalname,
            total: rows.length,
            inserted,
            updated,
            skipped,
            errorCount: errors.length,
            inventoryTemplates,
          },
          ipAddress: req.ip ?? undefined,
        });
      } catch { /* audit failure is non-fatal */ }
    }

    res.json({ inserted, updated, skipped, errors, inventoryTemplates });
  }
);

// ─── GET /api/admin/products — list all products (admin only) ─────────────────
router.get(
  "/admin/products",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    const rows = await db.select().from(catalogItemsTable);
    res.json({ products: rows });
  }
);

// ─── Spec doc aliases ─────────────────────────────────────────────────────────
router.get(
  "/admin/import/catalog-template",
  requireRole("global_admin", "admin"),
  (_req, res): void => {
    res.redirect(307, "/api/admin/products/import-template");
  }
);

router.post(
  "/admin/import/catalog",
  requireRole("global_admin", "admin"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upload.single("file") as any,
  (_req, res): void => {
    res.redirect(307, "/api/admin/products/import");
  }
);

export default router;
