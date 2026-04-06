import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, catalogItemsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

// Required headers after normalization
const REQUIRED_HEADERS = [
  "lucifer_cruz_name", "regular_price",
];

// Map of alternate header names → canonical names
// Handles the real exported CSV format as well as the normalized format
const HEADER_ALIASES: Record<string, string> = {
  "regular price": "regular_price",
  "homie price": "homie_price",
  "alavont image_url": "alavont_image_url",
  "alavont iname": "alavont_name",
  "alavont idescription": "alavont_description",
  "alavont i category": "alavont_category",
  "alavont in_stock": "alavont_in_stock",
  "alavont i is_upsell": "alavont_is_upsell",
  "alavont i id": "alavont_id",
  "alavont i created_date": "alavont_created_date",
  "alavont i updated_date": "alavont_updated_date",
  "alavont i created_by_id": "alavont_created_by_id",
  "alavont i created_by": "alavont_created_by",
  "alavont i is_sample": "alavont_is_sample",
  "lucifr cruz- name": "lucifer_cruz_name",
  "lucifer cruz- name": "lucifer_cruz_name",
  "lucifer cruz name": "lucifer_cruz_name",
  "lucifer_cruz- name": "lucifer_cruz_name",
};

function normalizeHeader(h: string): string {
  const lower = h.toLowerCase().trim();
  return HEADER_ALIASES[lower] ?? lower.replace(/[\s\-]+/g, "_");
}

function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  // Strip BOM
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  function parseLine(line: string): string[] {
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

  const headers = parseLine(lines[0]).map(normalizeHeader);
  const rows = lines.slice(1).map(line => {
    const vals = parseLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] ?? "").trim(); });
    return obj;
  });
  return { headers, rows };
}

function parseBool(v: string): boolean {
  return ["true", "1", "yes", "y"].includes(v.toLowerCase().trim());
}

// POST /api/admin/products/import
router.post(
  "/admin/products/import",
  requireRole("tenant_admin", "global_admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    if (!actor.tenantId) { res.status(400).json({ error: "No tenant" }); return; }

    const { csvContent } = req.body as { csvContent?: string };
    if (!csvContent || typeof csvContent !== "string") {
      res.status(400).json({ error: "csvContent (string) is required" }); return;
    }

    const { headers, rows } = parseCSV(csvContent);

    const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
    if (missing.length) {
      res.status(400).json({ error: `Missing required columns: ${missing.join(", ")}` }); return;
    }

    let inserted = 0, updated = 0, skipped = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      const alavontId = row.alavont_id?.trim() || null;

      // alavont_name falls back to lucifer_cruz_name if not provided
      const luciferCruzName = row.lucifer_cruz_name?.trim();
      if (!luciferCruzName) { errors.push(`Row ${rowNum}: lucifer_cruz_name is required`); skipped++; continue; }

      const alavontName = row.alavont_name?.trim() || luciferCruzName;

      const regularPrice = parseFloat(row.regular_price);
      if (isNaN(regularPrice)) { errors.push(`Row ${rowNum}: regular_price must be numeric`); skipped++; continue; }

      // Skip base64 images (too large to store as-is) and Google Drive links
      const rawImgUrl = row.alavont_image_url?.trim() || "";
      const isBase64 = rawImgUrl.startsWith("data:");
      const isGoogleDrive = rawImgUrl.includes("drive.google.com");
      const alavontImageUrl = (!isBase64 && !isGoogleDrive && rawImgUrl) ? rawImgUrl : null;

      const rawLcImgUrl = row.lucifer_cruz_image_url?.trim() || "";
      const lcImgIsBase64 = rawLcImgUrl.startsWith("data:");
      const lcImgIsGDrive = rawLcImgUrl.includes("drive.google.com");
      const luciferCruzImageUrl = (!lcImgIsBase64 && !lcImgIsGDrive && rawLcImgUrl) ? rawLcImgUrl : alavontImageUrl;

      const values = {
        tenantId: actor.tenantId,
        // Keep legacy fields in sync
        name: alavontName,
        description: row.alavont_description?.trim() || null,
        category: row.alavont_category?.trim() || "Uncategorized",
        price: String(regularPrice.toFixed(2)),
        isAvailable: parseBool(row.alavont_in_stock ?? "true"),
        // Dual-brand fields
        regularPrice: String(regularPrice.toFixed(2)),
        homiePrice: row.homie_price ? String(parseFloat(row.homie_price).toFixed(2)) : null,
        alavontId,
        alavontName,
        alavontDescription: row.alavont_description?.trim() || null,
        alavontCategory: row.alavont_category?.trim() || null,
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
        receiptName: row.receipt_name?.trim() || luciferCruzName,
        labelName: row.label_name?.trim() || luciferCruzName,
        labName: row.lab_name?.trim() || alavontName,
        imageUrl: alavontImageUrl,
      };

      try {
        let existingId: number | undefined;
        // Only attempt deduplication if alavontId is present
        if (alavontId) {
          const [existing] = await db
            .select({ id: catalogItemsTable.id })
            .from(catalogItemsTable)
            .where(and(
              eq(catalogItemsTable.tenantId, actor.tenantId),
              eq((catalogItemsTable as any).alavontId, alavontId),
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
      } catch (err: any) {
        errors.push(`Row ${rowNum}: ${err?.message ?? "DB error"}`);
        skipped++;
      }
    }

    res.json({ inserted, updated, skipped, errors, total: rows.length });
  }
);

// GET /api/admin/products — list all products with full dual-brand fields (admin only)
router.get(
  "/admin/products",
  requireRole("tenant_admin", "global_admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    if (!actor.tenantId) { res.status(400).json({ error: "No tenant" }); return; }
    const rows = await db.select().from(catalogItemsTable)
      .where(eq(catalogItemsTable.tenantId, actor.tenantId));
    res.json({ products: rows });
  }
);

export default router;
