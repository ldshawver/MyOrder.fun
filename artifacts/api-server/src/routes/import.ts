import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, catalogItemsTable, auditLogsTable } from "@workspace/db";
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

// ─── Exact 15-column header set ───────────────────────────────────────────────
// Order matches the downloadable template; on import, headers are matched
// case-sensitively but the column order in the user's file does not matter.
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
  "Sale_price",
  "lucifer_cruz_image",
  "lucifer_cruz_name",
  "lucifer_cruz_desc",
  "lucifer_cruz_category",
  "lucifer_cruz_Inventory",
] as const;

export type ExpectedHeader = (typeof EXPECTED_HEADERS)[number];

// Header → record field name (per spec)
export const HEADER_TO_FIELD: Record<ExpectedHeader, string> = {
  "regular_price":         "regularPrice",
  "alavont_image":         "alavontImage",
  "alavont_name":          "alavontName",
  "alavont_desc":          "alavontDesc",
  "alavont_category":      "alavontCategory",
  "alavont_in_stock":      "alavontInStock",
  "alavont_id":            "alavontId",
  "Quantity":              "quantity",
  "Unit":                  "unit",
  "Sale_price":            "salePrice",
  "lucifer_cruz_image":    "luciferCruzImage",
  "lucifer_cruz_name":     "luciferCruzName",
  "lucifer_cruz_desc":     "luciferCruzDesc",
  "lucifer_cruz_category": "luciferCruzCategory",
  "lucifer_cruz_Inventory":"luciferCruzInventory",
};

const EXPECTED_SET = new Set<string>(EXPECTED_HEADERS);

// ─── Header normalization (BOM / whitespace strip only — case-sensitive) ──────
function cleanHeader(raw: string): string {
  return raw.replace(/^\uFEFF/, "").trim();
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

function parseBuffer(buffer: Buffer, originalName: string): ParsedFile {
  const ext = originalName.split(".").pop()?.toLowerCase() ?? "csv";

  if (ext === "xlsx" || ext === "xls") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (data.length < 1) return { headers: [], rawHeaders: [], rows: [] };
    const rawHeaders = (data[0] as unknown[]).map(String);
    const rows = (data.slice(1) as unknown[][]).map(r => r.map(v => String(v ?? "")));
    return {
      headers: rawHeaders.map(cleanHeader),
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
    headers: rawHeaders.map(cleanHeader),
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

function validateHeaders(headers: string[]): HeaderValidation {
  const present = new Set(headers);
  const missing = EXPECTED_HEADERS.filter(h => !present.has(h));
  const extra = headers.filter(h => !EXPECTED_SET.has(h));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

// ─── GET /api/admin/products/import-template ──────────────────────────────────
router.get(
  "/admin/products/import-template",
  requireRole("admin", "supervisor"),
  (_req, res): void => {
    const sampleRow = [
      "29.99",                              // regular_price
      "https://example.com/alavont.jpg",    // alavont_image
      "Midnight Recovery Complex",          // alavont_name
      "Advanced cellular recovery blend",   // alavont_desc
      "Dermatology",                        // alavont_category
      "true",                               // alavont_in_stock
      "ALV-001",                            // alavont_id
      "10",                                 // Quantity
      "ml",                                 // Unit
      "24.99",                              // Sale_price
      "https://example.com/lc.jpg",         // lucifer_cruz_image
      "Velvet Restore Set",                 // lucifer_cruz_name
      "Luxurious overnight treatment",      // lucifer_cruz_desc
      "Skin Care",                          // lucifer_cruz_category
      "MRC-LAB-001",                        // lucifer_cruz_Inventory
    ];
    const csv = [EXPECTED_HEADERS.join(","), sampleRow.join(",")].join("\n");
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
  requireRole("admin", "supervisor"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upload.single("file") as any,
  (req, res): void => {
    if (!req.file?.buffer) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    let parsed: ParsedFile;
    try {
      parsed = parseBuffer(req.file.buffer, req.file.originalname);
    } catch (e) {
      res.status(400).json({ error: `Could not parse file: ${(e as Error)?.message ?? "unknown"}` });
      return;
    }

    const { headers, rawHeaders } = parsed;
    const v = validateHeaders(headers);

    // Provide a structured view tailored to the existing UI.
    const headerMappings = headers.map((h, i) => ({
      original: rawHeaders[i] ?? h,
      canonical: h,
      recognized: EXPECTED_SET.has(h),
    }));

    res.json({
      headerMappings,
      missingRequired: v.missing,
      unknownHeaders: v.extra,
      requiredFields: EXPECTED_HEADERS.map(h => ({
        canonical: h,
        friendlyName: h,
        found: !v.missing.includes(h),
        mappedFrom: headers.includes(h) ? h : null,
      })),
      allCanonicals: EXPECTED_HEADERS.map(h => ({
        canonical: h,
        friendlyName: h,
        required: true,
      })),
      fileColumns: rawHeaders,
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
  salePrice: string;
  luciferCruzImage: string;
  luciferCruzName: string;
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
    salePrice:           get("Sale_price"),
    luciferCruzImage:    get("lucifer_cruz_image"),
    luciferCruzName:     get("lucifer_cruz_name"),
    luciferCruzDesc:     get("lucifer_cruz_desc"),
    luciferCruzCategory: get("lucifer_cruz_category"),
    luciferCruzInventory:get("lucifer_cruz_Inventory"),
  };
}

// ─── POST /api/admin/products/import ──────────────────────────────────────────
router.post(
  "/admin/products/import",
  requireRole("admin", "supervisor"),
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

    let parsed: ParsedFile;
    try {
      parsed = parseBuffer(req.file.buffer, req.file.originalname);
    } catch (e) {
      res.status(400).json({ error: `Could not parse file: ${(e as Error)?.message ?? "unknown"}` });
      return;
    }

    const { headers, rows } = parsed;
    const v = validateHeaders(headers);

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
      if (!rec.name) {
        errors.push({ row: rowNum, message: "Menu Name is required" });
        continue;
      }
      if (!rec.category) {
        errors.push({ row: rowNum, message: "Menu Category is required" });
        continue;
      }
      const regularPrice = parsePrice(rec.regularPrice);
      if (regularPrice === null) {
        errors.push({ row: rowNum, message: `Menu Regular Price must be numeric (got "${rec.regularPrice}")` });
        continue;
      }
      if (!rec.sku && !rec.externalMenuId) {
        errors.push({ row: rowNum, message: "Either Merchant Sku or Menu ID is required" });
        continue;
      }

      // ── Optional/coerced values ──
      const inStock = rec.inStock ? parseTruthy(rec.inStock) : true;
      const amount = parseAmount(rec.inventoryAmount);
      const imageUrl = rec.imageUrl && isValidUrl(rec.imageUrl) ? rec.imageUrl : null;
      const merchantImage = rec.merchantImage && isValidUrl(rec.merchantImage) ? rec.merchantImage : null;
      const merchantName = rec.merchantName || rec.name;

      // Build values for insert/update. We populate the new fields that the
      // 14-column spec defines, plus legacy columns (alavont*, lucifer_cruz*)
      // for backward compatibility with code paths that still read them.
      const values: typeof catalogItemsTable.$inferInsert = {
        tenantId: houseTenantId,
        name: rec.name,
        description: rec.description || null,
        category: rec.category,
        sku: rec.sku || null,
        price: regularPrice.toFixed(2),
        regularPrice: regularPrice.toFixed(2),
        isAvailable: inStock,
        imageUrl,
        // New fields per task #10 spec
        externalMenuId: rec.externalMenuId || null,
        inventoryAmount: amount !== null ? amount.toFixed(2) : null,
        unitMeasurement: rec.unitMeasurement || null,
        merchantName,
        merchantImage,
        merchantDescription: rec.merchantDescription || null,
        merchantCategory: rec.merchantCategory || null,
        // Legacy mirrors so other routes that still read alavont*/lucifer_cruz*
        // continue to work (downstream task converts these to lucifer cruz).
        alavontId: rec.externalMenuId || null,
        alavontName: rec.name,
        alavontDescription: rec.description || null,
        alavontCategory: rec.category,
        alavontImageUrl: imageUrl,
        alavontInStock: inStock,
        luciferCruzName: merchantName,
        luciferCruzImageUrl: merchantImage,
        luciferCruzDescription: rec.merchantDescription || null,
        luciferCruzCategory: rec.merchantCategory || null,
        receiptName: merchantName,
        labelName: merchantName,
        labName: rec.sku || null,
      };

      if (dryRun) {
        inserted++;
        continue;
      }

      try {
        // Upsert key: (tenantId, sku) if sku present, else (tenantId, externalMenuId)
        let existingId: number | undefined;
        if (rec.sku) {
          const [existing] = await db
            .select({ id: catalogItemsTable.id })
            .from(catalogItemsTable)
            .where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.sku, rec.sku)))
            .limit(1);
          existingId = existing?.id;
        } else if (rec.externalMenuId) {
          const [existing] = await db
            .select({ id: catalogItemsTable.id })
            .from(catalogItemsTable)
            .where(and(
              eq(catalogItemsTable.tenantId, houseTenantId),
              eq(catalogItemsTable.externalMenuId, rec.externalMenuId),
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
        errors.push({ row: rowNum, message: `database error — ${(err as Error)?.message ?? "unknown"}` });
      }
    }

    if (!dryRun) {
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
          },
          ipAddress: req.ip ?? undefined,
        });
      } catch { /* audit failure is non-fatal */ }
    }

    res.json({ inserted, updated, skipped, errors });
  }
);

// ─── GET /api/admin/products — list all products (admin only) ─────────────────
router.get(
  "/admin/products",
  requireRole("admin", "supervisor"),
  async (_req, res): Promise<void> => {
    const rows = await db.select().from(catalogItemsTable);
    res.json({ products: rows });
  }
);

// ─── Spec doc aliases ─────────────────────────────────────────────────────────
router.get(
  "/admin/import/catalog-template",
  requireRole("admin", "supervisor"),
  (_req, res): void => {
    res.redirect(307, "/api/admin/products/import-template");
  }
);

router.post(
  "/admin/import/catalog",
  requireRole("admin", "supervisor"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upload.single("file") as any,
  (_req, res): void => {
    res.redirect(307, "/api/admin/products/import");
  }
);

export default router;
