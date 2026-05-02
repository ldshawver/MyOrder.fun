import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, contractorProposalsTable } from "@workspace/db";
import type { ContractorProposal } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";
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

const ProposalBody = z.object({
  title: z.string().min(1),
  status: z.enum(["draft", "sent", "accepted", "rejected", "expired"]).optional(),
  clientName: z.string().nullable().optional(),
  clientEmail: z.string().nullable().optional(),
  clientCompany: z.string().nullable().optional(),
  validUntil: z.string().nullable().optional(),
  workType: z.string().nullable().optional(),
  pricingStructure: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
  terms: z.string().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  lineItems: z.array(LineItemSchema).nullable().optional(),
  subtotal: z.string().nullable().optional(),
  total: z.string().nullable().optional(),
  templateId: z.number().nullable().optional(),
});

function calcTotals(lineItems: { quantity: number; rate: number }[] | null | undefined) {
  if (!lineItems || lineItems.length === 0) return { subtotal: "0.00", total: "0.00" };
  const sum = lineItems.reduce((acc, li) => acc + li.quantity * li.rate, 0);
  return { subtotal: sum.toFixed(2), total: sum.toFixed(2) };
}

function serialize(p: ContractorProposal) {
  return {
    id: p.id,
    tenantId: p.tenantId,
    templateId: p.templateId,
    title: p.title,
    status: p.status,
    clientName: p.clientName,
    clientEmail: p.clientEmail,
    clientCompany: p.clientCompany,
    validUntil: p.validUntil,
    workType: p.workType,
    pricingStructure: p.pricingStructure,
    scope: p.scope,
    terms: p.terms,
    paymentTerms: p.paymentTerms,
    notes: p.notes,
    lineItems: p.lineItems,
    subtotal: p.subtotal,
    total: p.total,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ─── GET /api/contractor-hub/proposals ───────────────────────────────────────
router.get("/contractor-hub/proposals", async (req, res): Promise<void> => {
  const tid = req.dbUser?.tenantId;
  if (!tid) { res.json({ proposals: [] }); return; }

  const rows = await db
    .select()
    .from(contractorProposalsTable)
    .where(eq(contractorProposalsTable.tenantId, tid))
    .orderBy(desc(contractorProposalsTable.updatedAt));

  res.json({ proposals: rows.map(serialize) });
});

// ─── GET /api/contractor-hub/proposals/:id ───────────────────────────────────
router.get("/contractor-hub/proposals/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select()
    .from(contractorProposalsTable)
    .where(eq(contractorProposalsTable.id, id))
    .limit(1);

  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const tid = req.dbUser?.tenantId;
  if (row.tenantId !== null && row.tenantId !== tid && req.dbUser?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  res.json({ proposal: serialize(row) });
});

// ─── POST /api/contractor-hub/proposals ──────────────────────────────────────
router.post("/contractor-hub/proposals", async (req, res): Promise<void> => {
  const parsed = ProposalBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { lineItems } = parsed.data;
  const totals = calcTotals(lineItems ?? null);

  const [row] = await db
    .insert(contractorProposalsTable)
    .values({
      ...parsed.data,
      tenantId: req.dbUser!.tenantId ?? null,
      createdBy: req.dbUser!.id,
      subtotal: parsed.data.subtotal ?? totals.subtotal,
      total: parsed.data.total ?? totals.total,
    })
    .returning();

  res.status(201).json({ proposal: serialize(row) });
});

// ─── PATCH /api/contractor-hub/proposals/:id ─────────────────────────────────
router.patch("/contractor-hub/proposals/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db
    .select()
    .from(contractorProposalsTable)
    .where(eq(contractorProposalsTable.id, id))
    .limit(1);

  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const tid = req.dbUser?.tenantId;
  if (existing.tenantId !== null && existing.tenantId !== tid && req.dbUser?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const parsed = ProposalBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const lineItems = parsed.data.lineItems ?? existing.lineItems as typeof parsed.data.lineItems;
  const totals = calcTotals(lineItems);

  const [updated] = await db
    .update(contractorProposalsTable)
    .set({
      ...parsed.data,
      subtotal: parsed.data.subtotal ?? totals.subtotal,
      total: parsed.data.total ?? totals.total,
    })
    .where(and(eq(contractorProposalsTable.id, id)))
    .returning();

  res.json({ proposal: serialize(updated) });
});

// ─── DELETE /api/contractor-hub/proposals/:id ────────────────────────────────
router.delete("/contractor-hub/proposals/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db
    .select()
    .from(contractorProposalsTable)
    .where(eq(contractorProposalsTable.id, id))
    .limit(1);

  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const tid = req.dbUser?.tenantId;
  if (existing.tenantId !== null && existing.tenantId !== tid && req.dbUser?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  await db.delete(contractorProposalsTable).where(eq(contractorProposalsTable.id, id));
  res.json({ ok: true });
});

export default router;
