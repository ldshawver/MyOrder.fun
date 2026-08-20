import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { db, inventoryLocationsTable, taxConfigurationsTable } from "@workspace/db";
import { loadDbUser, requireApproved, requireAuth, requireDbUser, writeAuditLog } from "../lib/auth";
import { requirePermission } from "../lib/roles";

const router: IRouter = Router();
const auth = [requireAuth, loadDbUser, requireDbUser, requireApproved, requirePermission("settings.edit_business")] as const;
const Body = z.object({ locationId: z.number().int().positive(), jurisdiction: z.string().trim().min(2).max(200), rate: z.number().min(0).max(1), sourcingRule: z.enum(["origin", "destination", "pickup"]), effectiveFrom: z.string().date(), effectiveUntil: z.string().date().nullable().optional(), sourceName: z.literal("California Department of Tax and Fee Administration"), sourceUrl: z.string().url().refine(url => new URL(url).hostname === "cdtfa.ca.gov" || new URL(url).hostname === "www.cdtfa.ca.gov") }).strict();

router.get("/admin/tax-configurations", ...auth, async (req, res) => {
  const rows = await db.select().from(taxConfigurationsTable).where(eq(taxConfigurationsTable.tenantId, req.dbUser!.tenantId!)).orderBy(desc(taxConfigurationsTable.effectiveFrom));
  res.json({ configurations: rows.map(row => ({ id: row.id, locationId: row.locationId, jurisdiction: row.jurisdiction, rate: Number(row.rate), sourcingRule: row.sourcingRule, effectiveFrom: row.effectiveFrom, effectiveUntil: row.effectiveUntil, sourceName: row.sourceName, sourceUrl: row.sourceUrl, verifiedAt: row.verifiedAt })) });
});

router.post("/admin/tax-configurations", ...auth, async (req, res) => {
  const parsed = Body.safeParse(req.body); if (!parsed.success) { res.status(422).json({ error: "INVALID_TAX_CONFIGURATION" }); return; }
  const actor = req.dbUser!; const input = parsed.data;
  const [location] = await db.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, actor.tenantId!), eq(inventoryLocationsTable.id, input.locationId))).limit(1);
  if (!location) { res.status(404).json({ error: "LOCATION_NOT_FOUND" }); return; }
  const overlapping = await db.select({ id: taxConfigurationsTable.id }).from(taxConfigurationsTable).where(and(eq(taxConfigurationsTable.tenantId, actor.tenantId!), eq(taxConfigurationsTable.locationId, input.locationId), lte(taxConfigurationsTable.effectiveFrom, input.effectiveUntil ?? "9999-12-31"), or(isNull(taxConfigurationsTable.effectiveUntil), gte(taxConfigurationsTable.effectiveUntil, input.effectiveFrom)))).limit(1);
  if (overlapping.length) { res.status(409).json({ error: "OVERLAPPING_TAX_CONFIGURATION" }); return; }
  const [created] = await db.insert(taxConfigurationsTable).values({ tenantId: actor.tenantId!, locationId: input.locationId, jurisdiction: input.jurisdiction, rate: String(input.rate), sourcingRule: input.sourcingRule, effectiveFrom: input.effectiveFrom, effectiveUntil: input.effectiveUntil ?? null, sourceName: input.sourceName, sourceUrl: input.sourceUrl, verifiedAt: new Date(), verifiedByUserId: actor.id }).returning();
  await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, tenantId: actor.tenantId!, action: "sales_tax.configuration_created", resourceType: "tax_configuration", resourceId: String(created.id), metadata: { locationId: input.locationId, jurisdiction: input.jurisdiction, rate: input.rate, effectiveFrom: input.effectiveFrom, effectiveUntil: input.effectiveUntil ?? null, sourceUrl: input.sourceUrl } });
  res.status(201).json({ id: created.id });
});

export default router;
