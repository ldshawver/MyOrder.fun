import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, catalogItemsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

const REQUIRED_HEADERS = [
  "alavont_id", "alavont_name", "lucifer_cruz_name", "regular_price",
  "alavont_in_stock", "alavont_is_upsell", "alavont_category",
];

function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
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

  const headers = parseLine(lines[0]).map(h => h.toLowerCase().trim());
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

      const alavontId = row.alavont_id?.trim();
      if (!alavontId) { errors.push(`Row ${rowNum}: alavont_id is required`); skipped++; continue; }

      const alavontName = row.alavont_name?.trim();
      if (!alavontName) { errors.push(`Row ${rowNum}: alavont_name is required`); skipped++; continue; }

      const luciferCruzName = row.lucifer_cruz_name?.trim();
      if (!luciferCruzName) { errors.push(`Row ${rowNum}: lucifer_cruz_name is required`); skipped++; continue; }

      const regularPrice = parseFloat(row.regular_price);
      if (isNaN(regularPrice)) { errors.push(`Row ${rowNum}: regular_price must be numeric`); skipped++; continue; }

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
        alavontImageUrl: row.alavont_image_url?.trim() || null,
        alavontInStock: parseBool(row.alavont_in_stock ?? "true"),
        alavontIsUpsell: parseBool(row.alavont_is_upsell ?? "false"),
        alavontIsSample: parseBool(row.alavont_is_sample ?? "false"),
        alavontCreatedDate: row.alavont_created_date?.trim() || null,
        alavontUpdatedDate: row.alavont_updated_date?.trim() || null,
        alavontCreatedById: row.alavont_created_by_id?.trim() || null,
        alavontCreatedBy: row.alavont_created_by?.trim() || null,
        luciferCruzName,
        luciferCruzImageUrl: row.lucifer_cruz_image_url?.trim() || null,
        luciferCruzDescription: row.lucifer_cruz_description?.trim() || null,
        receiptName: row.receipt_name?.trim() || luciferCruzName,
        labelName: row.label_name?.trim() || luciferCruzName,
        labName: row.lab_name?.trim() || alavontName,
        imageUrl: row.alavont_image_url?.trim() || null,
      };

      try {
        const [existing] = await db
          .select({ id: catalogItemsTable.id })
          .from(catalogItemsTable)
          .where(and(
            eq(catalogItemsTable.tenantId, actor.tenantId),
            eq(catalogItemsTable.alavontId, alavontId),
          ))
          .limit(1);

        if (existing) {
          await db.update(catalogItemsTable).set(values).where(eq(catalogItemsTable.id, existing.id));
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
