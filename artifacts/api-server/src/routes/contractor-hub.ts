import { Router, type IRouter } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db, contractorTemplatesTable } from "@workspace/db";
import type { ContractorTemplate } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { z } from "zod/v4";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const LineItemSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unit: z.string(),
  rate: z.number(),
  amount: z.number(),
});

const TemplateWriteBody = z.object({
  name: z.string().min(1),
  templateType: z.enum(["proposal", "invoice"]),
  styleLevel: z.enum(["minimal", "standard", "detailed", "branded"]),
  description: z.string().nullable().optional(),
  workType: z.string().nullable().optional(),
  pricingStructure: z.string().nullable().optional(),
  defaultScope: z.string().nullable().optional(),
  defaultTerms: z.string().nullable().optional(),
  defaultPaymentTerms: z.string().nullable().optional(),
  defaultNotes: z.string().nullable().optional(),
  defaultLineItems: z.array(LineItemSchema).nullable().optional(),
  brandingEnabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

function serializeTemplate(t: ContractorTemplate) {
  return {
    id: t.id,
    companyId: t.companyId,
    name: t.name,
    templateType: t.templateType,
    styleLevel: t.styleLevel,
    description: t.description,
    workType: t.workType,
    pricingStructure: t.pricingStructure,
    defaultScope: t.defaultScope,
    defaultTerms: t.defaultTerms,
    defaultPaymentTerms: t.defaultPaymentTerms,
    defaultNotes: t.defaultNotes,
    defaultLineItems: t.defaultLineItems,
    brandingEnabled: t.brandingEnabled,
    isDefault: t.isDefault,
    isActive: t.isActive,
    isPlatformDefault: t.companyId === null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ─── GET /api/contractor-hub/templates ───────────────────────────────────────
router.get("/contractor-hub/templates", async (req, res): Promise<void> => {
  const type = req.query.type as string | undefined;
  const companyId = req.query.company_id ? parseInt(req.query.company_id as string, 10) : undefined;

  // Build rows: platform defaults + company-specific (if company_id filter given)
  let rows: ContractorTemplate[];
  if (companyId !== undefined && !isNaN(companyId)) {
    rows = await db
      .select()
      .from(contractorTemplatesTable)
      .where(
        and(
          eq(contractorTemplatesTable.isActive, true),
          eq(contractorTemplatesTable.companyId, companyId),
        )
      )
      .orderBy(contractorTemplatesTable.styleLevel);
    // Also include platform defaults
    const platformDefaults = await db
      .select()
      .from(contractorTemplatesTable)
      .where(
        and(
          eq(contractorTemplatesTable.isActive, true),
          isNull(contractorTemplatesTable.companyId),
        )
      )
      .orderBy(contractorTemplatesTable.styleLevel);
    rows = [...platformDefaults, ...rows];
  } else {
    rows = await db
      .select()
      .from(contractorTemplatesTable)
      .where(
        and(
          eq(contractorTemplatesTable.isActive, true),
          isNull(contractorTemplatesTable.companyId),
        )
      )
      .orderBy(contractorTemplatesTable.styleLevel);
  }

  let filtered = rows;
  if (type === "proposal" || type === "invoice") {
    filtered = rows.filter(r => r.templateType === type);
  }

  res.json({ templates: filtered.map(serializeTemplate) });
});

// ─── GET /api/contractor-hub/templates/:id ───────────────────────────────────
router.get("/contractor-hub/templates/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select()
    .from(contractorTemplatesTable)
    .where(eq(contractorTemplatesTable.id, id))
    .limit(1);

  if (!row) { res.status(404).json({ error: "Template not found" }); return; }
  res.json({ template: serializeTemplate(row) });
});

// ─── POST /api/contractor-hub/templates ──────────────────────────────────────
router.post(
  "/contractor-hub/templates",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const parsed = TemplateWriteBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const [row] = await db
      .insert(contractorTemplatesTable)
      .values({
        ...parsed.data,
        companyId: parsed.data.isDefault ? null : (req.dbUser?.id ?? null),
        brandingEnabled: parsed.data.brandingEnabled ?? false,
        isDefault: false,
        isActive: true,
      })
      .returning();

    res.status(201).json({ template: serializeTemplate(row) });
  }
);

// ─── PATCH /api/contractor-hub/templates/:id ─────────────────────────────────
router.patch(
  "/contractor-hub/templates/:id",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const [existing] = await db
      .select()
      .from(contractorTemplatesTable)
      .where(eq(contractorTemplatesTable.id, id))
      .limit(1);

    if (!existing) { res.status(404).json({ error: "Template not found" }); return; }
    if (existing.companyId === null && req.dbUser?.role !== "admin") {
      res.status(403).json({ error: "Platform default templates can only be edited by platform admins" });
      return;
    }

    const parsed = TemplateWriteBody.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const [updated] = await db
      .update(contractorTemplatesTable)
      .set({ ...parsed.data, isDefault: existing.isDefault })
      .where(eq(contractorTemplatesTable.id, id))
      .returning();

    res.json({ template: serializeTemplate(updated) });
  }
);

// ─── DELETE /api/contractor-hub/templates/:id ────────────────────────────────
router.delete(
  "/contractor-hub/templates/:id",
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const [existing] = await db
      .select()
      .from(contractorTemplatesTable)
      .where(eq(contractorTemplatesTable.id, id))
      .limit(1);

    if (!existing) { res.status(404).json({ error: "Template not found" }); return; }
    if (existing.companyId === null) {
      res.status(403).json({ error: "Platform default templates cannot be deleted" });
      return;
    }

    await db
      .update(contractorTemplatesTable)
      .set({ isActive: false })
      .where(eq(contractorTemplatesTable.id, id));

    res.json({ ok: true });
  }
);

// ─── POST /api/contractor-hub/templates/:id/clone ────────────────────────────
router.post(
  "/contractor-hub/templates/:id/clone",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const [source] = await db
      .select()
      .from(contractorTemplatesTable)
      .where(eq(contractorTemplatesTable.id, id))
      .limit(1);

    if (!source) { res.status(404).json({ error: "Template not found" }); return; }

    const customName = (req.body as { name?: string })?.name?.trim() || `${source.name} (Copy)`;

    const [cloned] = await db
      .insert(contractorTemplatesTable)
      .values({
        companyId: req.dbUser!.id,
        name: customName,
        templateType: source.templateType,
        styleLevel: source.styleLevel,
        description: source.description,
        workType: source.workType,
        pricingStructure: source.pricingStructure,
        defaultScope: source.defaultScope,
        defaultTerms: source.defaultTerms,
        defaultPaymentTerms: source.defaultPaymentTerms,
        defaultNotes: source.defaultNotes,
        defaultLineItems: source.defaultLineItems as never,
        brandingEnabled: source.brandingEnabled,
        isDefault: false,
        isActive: true,
      })
      .returning();

    res.status(201).json({ template: serializeTemplate(cloned) });
  }
);

export default router;
