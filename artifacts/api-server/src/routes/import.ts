import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
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
    const ok = /\.(csv|xlsx|xls)$/i.test(file.originalname) ||
      file.mimetype === "text/csv" ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel";
    cb(null, ok);
  },
});

// ─── Canonical header list (the downloadable template uses these exactly) ─────
export const CANONICAL_HEADERS = [
  "regular_price",
  "alavont_image_url",
  "alavont_name",
  "alavont_description",
  "alavont_category",
  "alavont_in_stock",
  "alavont_is_upsell",
  "alavont_id",
  "alavont_created_date",
  "alavont_updated_date",
  "alavont_created_by_id",
  "alavont_created_by",
  "alavont_is_sample",
  "homie_price",
  "lucifer_cruz_name",
  "lucifer_cruz_image_url",
  "lucifer_cruz_description",
  "lucifer_cruz_category",
  "lab_name",
] as const;

const CANONICAL_SET = new Set<string>(CANONICAL_HEADERS);

// Required after normalization
const REQUIRED_HEADERS: string[] = [
  "regular_price",
  "alavont_name",
  "alavont_category",
  "lucifer_cruz_name",
  "lab_name",
];

// ─── Alias map ────────────────────────────────────────────────────────────────
// Keys are lowercase (exact or normalized), values are canonical field names.
// Add new aliases here — no other code needs changing.
const HEADER_ALIASES: Record<string, string> = {
  // regular_price
  "regular price":                   "regular_price",
  "price":                           "regular_price",

  // alavont_image_url
  "alavont image_url":               "alavont_image_url",
  "alavont image url":               "alavont_image_url",

  // alavont_name
  "alavont iname":                   "alavont_name",
  "alavont i name":                  "alavont_name",
  "alavont_i_name":                  "alavont_name",

  // alavont_description
  "alavont-idescription":            "alavont_description",
  "alavont_idescription":            "alavont_description",
  "alavont i description":           "alavont_description",
  "alavont_i_description":           "alavont_description",
  "alavont-description":             "alavont_description",
  "alavont idescription":            "alavont_description",

  // alavont_category
  "alavont i category":              "alavont_category",
  "alavont_i_category":              "alavont_category",
  "alavont icategory":               "alavont_category",

  // alavont_in_stock
  "alavont in_stock":                "alavont_in_stock",
  "alavont in stock":                "alavont_in_stock",

  // alavont_is_upsell
  "alavont i is_upsell":             "alavont_is_upsell",
  "alavont_i_is_upsell":             "alavont_is_upsell",
  "alavont i isupsell":              "alavont_is_upsell",
  "alavont iisupsell":               "alavont_is_upsell",

  // alavont_id
  "alavont i id":                    "alavont_id",
  "alavont_i_id":                    "alavont_id",
  "alavont iid":                     "alavont_id",

  // alavont_created_date
  "alavont i created_date":          "alavont_created_date",
  "alavont_i_created_date":          "alavont_created_date",
  "alavont i created date":          "alavont_created_date",

  // alavont_updated_date
  "alavont i updated_date":          "alavont_updated_date",
  "alavont_i_updated_date":          "alavont_updated_date",
  "alavont i updated date":          "alavont_updated_date",

  // alavont_created_by_id
  "alavont i created_by_id":         "alavont_created_by_id",
  "alavont_i_created_by_id":         "alavont_created_by_id",
  "alavont i created by id":         "alavont_created_by_id",

  // alavont_created_by
  "alavont i created_by":            "alavont_created_by",
  "alavont_i_created_by":            "alavont_created_by",
  "alavont i created by":            "alavont_created_by",

  // alavont_is_sample
  "alavont i is_sample":             "alavont_is_sample",
  "alavont_i_is_sample":             "alavont_is_sample",
  "alavont i issample":              "alavont_is_sample",

  // homie_price
  "homie price":                     "homie_price",

  // lucifer_cruz_name — many typo variants
  "lucifr cruz- name":               "lucifer_cruz_name",
  "lucifer cruz- name":              "lucifer_cruz_name",
  "lucifer cruz name":               "lucifer_cruz_name",
  "lucifer_cruz- name":              "lucifer_cruz_name",
  "lucifr_cruz_name":                "lucifer_cruz_name",
  "lucifer-name":                    "lucifer_cruz_name",
  "lucifer_name":                    "lucifer_cruz_name",
  "lucifer name":                    "lucifer_cruz_name",
  "lucifer cruz_ name":              "lucifer_cruz_name",

  // lucifer_cruz_image_url
  "lucifer-image_url":               "lucifer_cruz_image_url",
  "lucifer_image_url":               "lucifer_cruz_image_url",
  "lucifer image_url":               "lucifer_cruz_image_url",
  "lucifer image url":               "lucifer_cruz_image_url",
  "lucifer cruz image_url":          "lucifer_cruz_image_url",
  "lucifer cruz image url":          "lucifer_cruz_image_url",

  // lucifer_cruz_description
  "lucifer-idescription":            "lucifer_cruz_description",
  "lucifer_idescription":            "lucifer_cruz_description",
  "lucifer-description":             "lucifer_cruz_description",
  "lucifer_description":             "lucifer_cruz_description",
  "lucifer i description":           "lucifer_cruz_description",
  "lucifer_i_description":           "lucifer_cruz_description",
  "lucifer cruz description":        "lucifer_cruz_description",
  "lucifer idescription":            "lucifer_cruz_description",

  // lucifer_cruz_category
  "lucifer-category":                "lucifer_cruz_category",
  "lucifer_category":                "lucifer_cruz_category",
  "lucifer category":                "lucifer_cruz_category",
  "lucifer cruz category":           "lucifer_cruz_category",

  // lab_name
  "lab name":                        "lab_name",
};

// ─── Header normalizer ────────────────────────────────────────────────────────
export type HeaderMapping = {
  original: string;
  canonical: string;
  recognized: boolean;
};

export function normalizeHeader(raw: string): HeaderMapping {
  const lower = raw.toLowerCase().trim();

  // 1. Already a canonical name
  if (CANONICAL_SET.has(lower)) {
    return { original: raw, canonical: lower, recognized: true };
  }

  // 2. Exact alias match on lowercase
  if (HEADER_ALIASES[lower]) {
    return { original: raw, canonical: HEADER_ALIASES[lower], recognized: true };
  }

  // 3. Normalize: spaces/dashes → _, strip non-alnum/_, collapse/trim underscores
  const norm = lower
    .replace(/[\s\u2013\u2014\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  // 4. Normalized is already canonical
  if (CANONICAL_SET.has(norm)) {
    return { original: raw, canonical: norm, recognized: true };
  }

  // 5. Alias on normalized form
  if (HEADER_ALIASES[norm]) {
    return { original: raw, canonical: HEADER_ALIASES[norm], recognized: true };
  }

  // 6. Unrecognized — pass through normalized for logging
  return { original: raw, canonical: norm, recognized: false };
}

// ─── Parsers ──────────────────────────────────────────────────────────────────
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === "," && !inQuote) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

type ParseResult = {
  headerMappings: HeaderMapping[];
  canonicalHeaders: string[];
  rows: Record<string, string>[];
};

function parseBuffer(buffer: Buffer, ext: string): ParseResult {
  let rawHeaders: string[];
  let rawRows: string[][];

  if (ext === "csv") {
    const text = buffer.toString("utf-8").replace(/^\uFEFF/, "");
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
    if (lines.length < 2) return { headerMappings: [], canonicalHeaders: [], rows: [] };
    rawHeaders = parseCsvLine(lines[0]);
    rawRows = lines.slice(1).map(parseCsvLine);
  } else {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (data.length < 2) return { headerMappings: [], canonicalHeaders: [], rows: [] };
    rawHeaders = (data[0] as unknown[]).map(String);
    rawRows = (data.slice(1) as unknown[][]).map(r => r.map(String));
  }

  const headerMappings = rawHeaders.map(normalizeHeader);
  const canonicalHeaders = headerMappings.map(m => m.canonical);

  const rows = rawRows.map(vals => {
    const obj: Record<string, string> = {};
    canonicalHeaders.forEach((h, i) => { obj[h] = (vals[i] ?? "").trim(); });
    return obj;
  });

  return { headerMappings, canonicalHeaders, rows };
}

// ─── Validators / coercers ────────────────────────────────────────────────────
function parseBool(v: string): boolean {
  return ["true", "1", "yes", "y"].includes(v.toLowerCase().trim());
}

function parsePrice(raw: string): number | null {
  if (!raw?.trim()) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function isValidUrl(s: string): boolean {
  try { new URL(s); return true; } catch { return false; }
}

// ─── GET /api/admin/products/import-template ──────────────────────────────────
router.get(
  "/admin/products/import-template",
  requireRole("admin", "supervisor"),
  (_req, res): void => {
    const sampleRow = [
      "29.99", "https://example.com/img.jpg", "Midnight Recovery Complex",
      "Advanced cellular recovery blend", "Dermatology", "true", "false",
      "ALV-001", "2025-01-01", "2025-06-01", "u001", "Dr. Adams", "false",
      "24.99", "Velvet Restore Set", "https://example.com/lc.jpg",
      "Luxurious overnight treatment", "Skin Care", "MRC-Lab",
    ];
    const csvContent = [CANONICAL_HEADERS.join(","), sampleRow.join(",")].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="menu_import_template.csv"');
    res.send(csvContent);
  }
);

// ─── POST /api/admin/products/import ─────────────────────────────────────────
// Accepts multipart/form-data with field "file" (CSV or XLSX)
// Optional query: ?dryRun=true to validate without writing
router.post(
  "/admin/products/import",
  requireRole("admin", "supervisor"),
  upload.single("file") as any,
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const houseTenantId = await getHouseTenantId();
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;

    if (!req.file?.buffer) {
      res.status(400).json({ error: "A file upload is required (CSV or XLSX)" });
      return;
    }

    const ext = req.file.originalname.split(".").pop()?.toLowerCase() ?? "csv";
    const fileExt = ["xlsx", "xls"].includes(ext) ? "xlsx" : "csv";

    let parsed: ParseResult;
    try {
      parsed = parseBuffer(req.file.buffer, fileExt);
    } catch (e: any) {
      res.status(400).json({ error: `Could not parse file: ${e?.message ?? "unknown error"}` });
      return;
    }

    const { headerMappings, canonicalHeaders, rows } = parsed;

    // Check for required columns
    const missing = REQUIRED_HEADERS.filter(h => !canonicalHeaders.includes(h));
    if (missing.length) {
      res.status(400).json({
        error: `Missing required columns: ${missing.join(", ")}`,
        headerMappings,
      });
      return;
    }

    let inserted = 0, updated = 0, skipped = 0, failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      // ── Required field validation ──────────────────────────────────────────
      const luciferCruzName = row.lucifer_cruz_name?.trim();
      if (!luciferCruzName) {
        errors.push(`Row ${rowNum}: lucifer_cruz_name is required`);
        failed++;
        continue;
      }

      const alavontName = row.alavont_name?.trim() || luciferCruzName;
      if (!alavontName) {
        errors.push(`Row ${rowNum}: alavont_name is required`);
        failed++;
        continue;
      }

      const alavontCategory = row.alavont_category?.trim();
      if (!alavontCategory) {
        errors.push(`Row ${rowNum}: alavont_category is required`);
        failed++;
        continue;
      }

      const labName = row.lab_name?.trim();
      if (!labName) {
        errors.push(`Row ${rowNum}: lab_name is required`);
        failed++;
        continue;
      }

      // ── Price validation ───────────────────────────────────────────────────
      const regularPrice = parsePrice(row.regular_price);
      if (regularPrice === null) {
        errors.push(`Row ${rowNum}: regular_price must be numeric (got "${row.regular_price}")`);
        failed++;
        continue;
      }

      const homiePrice = row.homie_price?.trim() ? parsePrice(row.homie_price) : null;
      if (row.homie_price?.trim() && homiePrice === null) {
        errors.push(`Row ${rowNum}: homie_price must be numeric if provided (got "${row.homie_price}")`);
        failed++;
        continue;
      }

      // ── Image URL validation (optional but must be valid if present) ───────
      const rawImgUrl = row.alavont_image_url?.trim() || "";
      const skipImg = rawImgUrl.startsWith("data:") || rawImgUrl.includes("drive.google.com");
      const alavontImageUrl = (!skipImg && rawImgUrl && isValidUrl(rawImgUrl)) ? rawImgUrl : null;
      if (rawImgUrl && !skipImg && !isValidUrl(rawImgUrl)) {
        errors.push(`Row ${rowNum}: alavont_image_url is not a valid URL — skipped`);
      }

      const rawLcImgUrl = row.lucifer_cruz_image_url?.trim() || "";
      const skipLcImg = rawLcImgUrl.startsWith("data:") || rawLcImgUrl.includes("drive.google.com");
      const luciferCruzImageUrl = (!skipLcImg && rawLcImgUrl && isValidUrl(rawLcImgUrl))
        ? rawLcImgUrl
        : alavontImageUrl;

      const alavontId = row.alavont_id?.trim() || null;

      const values = {
        tenantId: houseTenantId,
        name: alavontName,
        description: row.alavont_description?.trim() || null,
        category: alavontCategory,
        price: String(regularPrice.toFixed(2)),
        isAvailable: parseBool(row.alavont_in_stock ?? "true"),
        regularPrice: String(regularPrice.toFixed(2)),
        homiePrice: homiePrice !== null ? String(homiePrice.toFixed(2)) : null,
        alavontId,
        alavontName,
        alavontDescription: row.alavont_description?.trim() || null,
        alavontCategory,
        alavontImageUrl,
        alavontInStock: parseBool(row.alavont_in_stock ?? "true"),
        alavontIsUpsell: parseBool(row.alavont_is_upsell ?? "false"),
        alavontIsSample: parseBool(row.alavont_is_sample ?? "false"),
        alavontCreatedDate: row.alavont_created_date?.trim() || null,
        alavontUpdatedDate: row.alavont_updated_date?.trim() || null,
        alavontCreatedById: row.alavont_created_by_id?.trim() || null,
        alavontCreatedBy: row.alavont_created_by?.trim() || null,
        luciferCruzName,
        luciferCruzImageUrl,
        luciferCruzDescription: row.lucifer_cruz_description?.trim() || null,
        receiptName: luciferCruzName,
        labelName: luciferCruzName,
        labName,
        imageUrl: alavontImageUrl,
        metadata: {
          luciferCruzCategory: row.lucifer_cruz_category?.trim() || null,
        },
      };

      if (dryRun) {
        inserted++;
        continue;
      }

      try {
        let existingId: number | undefined;
        if (alavontId) {
          const [existing] = await db
            .select({ id: catalogItemsTable.id })
            .from(catalogItemsTable)
            .where(eq((catalogItemsTable as any).alavontId, alavontId))
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
      } catch (err: any) {
        errors.push(`Row ${rowNum}: database error — ${err?.message ?? "unknown"}`);
        failed++;
        skipped++;
      }
    }

    // ── Audit log ─────────────────────────────────────────────────────────────
    if (!dryRun) {
      try {
        await db.insert(auditLogsTable).values({
          actorId: actor.id,
          actorEmail: actor.email,
          actorRole: actor.role,
          action: "menu_import",
          resourceType: "catalog_item",
          metadata: {
            fileName: req.file.originalname,
            fileType: fileExt,
            total: rows.length,
            inserted,
            updated,
            skipped,
            failed,
            errorCount: errors.length,
          },
          ipAddress: req.ip ?? null,
        });
      } catch { /* audit failure is non-fatal */ }
    }

    res.json({
      dryRun,
      total: rows.length,
      inserted,
      updated,
      skipped,
      failed,
      errors,
      headerMappings,
    });
  }
);

// ─── GET /api/admin/products — list all products (admin only) ─────────────────
router.get(
  "/admin/products",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const rows = await db.select().from(catalogItemsTable);
    res.json({ products: rows });
  }
);

export default router;
