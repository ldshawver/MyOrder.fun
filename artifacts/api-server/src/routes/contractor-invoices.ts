import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, contractorInvoicesTable } from "@workspace/db";
import type { ContractorInvoice } from "@workspace/db";
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

const InvoiceBody = z.object({
  title: z.string().min(1),
  status: z.enum(["draft", "sent", "paid", "overdue", "voided"]).optional(),
  invoiceNumber: z.string().nullable().optional(),
  clientName: z.string().nullable().optional(),
  clientEmail: z.string().nullable().optional(),
  clientCompany: z.string().nullable().optional(),
  issueDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  pricingStructure: z.string().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  lineItems: z.array(LineItemSchema).nullable().optional(),
  subtotal: z.string().nullable().optional(),
  taxAmount: z.string().nullable().optional(),
  discountAmount: z.string().nullable().optional(),
  total: z.string().nullable().optional(),
  amountPaid: z.string().nullable().optional(),
  balanceDue: z.string().nullable().optional(),
  templateId: z.number().nullable().optional(),
  proposalId: z.number().nullable().optional(),
});

function calcTotals(
  lineItems: { quantity: number; rate: number }[] | null | undefined,
  taxAmount: string | null | undefined,
  discountAmount: string | null | undefined,
  amountPaid: string | null | undefined,
) {
  const subtotal = (lineItems ?? []).reduce((acc, li) => acc + li.quantity * li.rate, 0);
  const tax = parseFloat(taxAmount ?? "0") || 0;
  const discount = parseFloat(discountAmount ?? "0") || 0;
  const paid = parseFloat(amountPaid ?? "0") || 0;
  const total = Math.max(0, subtotal + tax - discount);
  const balance = Math.max(0, total - paid);
  return {
    subtotal: subtotal.toFixed(2),
    total: total.toFixed(2),
    balanceDue: balance.toFixed(2),
  };
}

function serialize(inv: ContractorInvoice) {
  return {
    id: inv.id,
    tenantId: inv.tenantId,
    proposalId: inv.proposalId,
    templateId: inv.templateId,
    title: inv.title,
    invoiceNumber: inv.invoiceNumber,
    status: inv.status,
    clientName: inv.clientName,
    clientEmail: inv.clientEmail,
    clientCompany: inv.clientCompany,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    pricingStructure: inv.pricingStructure,
    paymentTerms: inv.paymentTerms,
    notes: inv.notes,
    lineItems: inv.lineItems,
    subtotal: inv.subtotal,
    taxAmount: inv.taxAmount,
    discountAmount: inv.discountAmount,
    total: inv.total,
    amountPaid: inv.amountPaid,
    balanceDue: inv.balanceDue,
    createdBy: inv.createdBy,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
  };
}

// ─── GET /api/contractor-hub/invoices ────────────────────────────────────────
router.get("/contractor-hub/invoices", async (req, res): Promise<void> => {
  const tid = req.dbUser?.tenantId;
  if (!tid) { res.json({ invoices: [] }); return; }

  const rows = await db
    .select()
    .from(contractorInvoicesTable)
    .where(eq(contractorInvoicesTable.tenantId, tid))
    .orderBy(desc(contractorInvoicesTable.updatedAt));

  res.json({ invoices: rows.map(serialize) });
});

// ─── GET /api/contractor-hub/invoices/:id ────────────────────────────────────
router.get("/contractor-hub/invoices/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select()
    .from(contractorInvoicesTable)
    .where(eq(contractorInvoicesTable.id, id))
    .limit(1);

  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const tid = req.dbUser?.tenantId;
  if (row.tenantId !== null && row.tenantId !== tid && req.dbUser?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  res.json({ invoice: serialize(row) });
});

// ─── POST /api/contractor-hub/invoices ───────────────────────────────────────
router.post("/contractor-hub/invoices", async (req, res): Promise<void> => {
  const parsed = InvoiceBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { lineItems, taxAmount, discountAmount, amountPaid } = parsed.data;
  const totals = calcTotals(lineItems ?? null, taxAmount, discountAmount, amountPaid);

  const [row] = await db
    .insert(contractorInvoicesTable)
    .values({
      ...parsed.data,
      tenantId: req.dbUser!.tenantId ?? null,
      createdBy: req.dbUser!.id,
      subtotal: parsed.data.subtotal ?? totals.subtotal,
      total: parsed.data.total ?? totals.total,
      balanceDue: parsed.data.balanceDue ?? totals.balanceDue,
    })
    .returning();

  res.status(201).json({ invoice: serialize(row) });
});

// ─── PATCH /api/contractor-hub/invoices/:id ──────────────────────────────────
router.patch("/contractor-hub/invoices/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db
    .select()
    .from(contractorInvoicesTable)
    .where(eq(contractorInvoicesTable.id, id))
    .limit(1);

  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const tid = req.dbUser?.tenantId;
  if (existing.tenantId !== null && existing.tenantId !== tid && req.dbUser?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const parsed = InvoiceBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const lineItems = parsed.data.lineItems ?? existing.lineItems as typeof parsed.data.lineItems;
  const taxAmount = parsed.data.taxAmount ?? existing.taxAmount;
  const discountAmount = parsed.data.discountAmount ?? existing.discountAmount;
  const amountPaid = parsed.data.amountPaid ?? existing.amountPaid;
  const totals = calcTotals(lineItems, taxAmount, discountAmount, amountPaid);

  const [updated] = await db
    .update(contractorInvoicesTable)
    .set({
      ...parsed.data,
      subtotal: parsed.data.subtotal ?? totals.subtotal,
      total: parsed.data.total ?? totals.total,
      balanceDue: parsed.data.balanceDue ?? totals.balanceDue,
    })
    .where(and(eq(contractorInvoicesTable.id, id)))
    .returning();

  res.json({ invoice: serialize(updated) });
});

// ─── DELETE /api/contractor-hub/invoices/:id ─────────────────────────────────
router.delete("/contractor-hub/invoices/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db
    .select()
    .from(contractorInvoicesTable)
    .where(eq(contractorInvoicesTable.id, id))
    .limit(1);

  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const tid = req.dbUser?.tenantId;
  if (existing.tenantId !== null && existing.tenantId !== tid && req.dbUser?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  await db.delete(contractorInvoicesTable).where(eq(contractorInvoicesTable.id, id));
  res.json({ ok: true });
});

export default router;
