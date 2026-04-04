import { Router, type IRouter } from "express";
import { eq, desc, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  printPrintersTable,
  printJobsTable,
  printJobAttemptsTable,
  printSettingsTable,
} from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole } from "../lib/auth";
import { createPrintJob, dispatchJob, getSettings, makeIdempotencyKey } from "../lib/printService";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

const adminOnly = requireRole("tenant_admin", "global_admin");

// ── GET /api/print/health ─────────────────────────────────────────────────
router.get("/print/health", adminOnly, async (_req, res): Promise<void> => {
  const printers = await db.select().from(printPrintersTable)
    .where(eq(printPrintersTable.isActive, true));

  const results = await Promise.all(printers.map(async (p) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const r = await fetch(`${p.bridgeUrl}/health`, {
        headers: { "x-api-key": p.apiKey ?? process.env.PRINT_BRIDGE_API_KEY ?? "" },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      const data = await r.json() as { status?: string };
      return { id: p.id, name: p.name, role: p.role, online: data.status === "ok" };
    } catch {
      return { id: p.id, name: p.name, role: p.role, online: false };
    }
  }));

  res.json({ printers: results });
});

// ── GET /api/print/printers ───────────────────────────────────────────────
router.get("/print/printers", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select().from(printPrintersTable).orderBy(printPrintersTable.name);
  res.json({ printers: rows });
});

const VALID_ROLES = ["kitchen", "receipt", "expo", "label", "bar"];

// ── POST /api/print/printers ──────────────────────────────────────────────
router.post("/print/printers", adminOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (!b.name) { res.status(400).json({ error: "name is required" }); return; }
  if (!b.bridgeUrl) { res.status(400).json({ error: "bridgeUrl is required" }); return; }
  if (b.role && !VALID_ROLES.includes(b.role)) {
    res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(", ")}` }); return;
  }
  const [printer] = await db.insert(printPrintersTable).values({
    name: String(b.name),
    role: String(b.role ?? "kitchen"),
    bridgeUrl: String(b.bridgeUrl),
    bridgePrinterName: b.bridgePrinterName ? String(b.bridgePrinterName) : null,
    apiKey: b.apiKey ? String(b.apiKey) : null,
    timeoutMs: b.timeoutMs ? Number(b.timeoutMs) : 8000,
    copies: b.copies ? Math.min(5, Math.max(1, Number(b.copies))) : 1,
    paperWidth: b.paperWidth ? String(b.paperWidth) : "80mm",
    isActive: b.isActive !== undefined ? Boolean(b.isActive) : true,
  }).returning();
  res.status(201).json({ printer });
});

// ── PATCH /api/print/printers/:id ─────────────────────────────────────────
router.patch("/print/printers/:id", adminOnly, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const b = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (b.name !== undefined) updates.name = String(b.name);
  if (b.role !== undefined) updates.role = String(b.role);
  if (b.bridgeUrl !== undefined) updates.bridgeUrl = String(b.bridgeUrl);
  if (b.bridgePrinterName !== undefined) updates.bridgePrinterName = String(b.bridgePrinterName);
  if (b.apiKey !== undefined) updates.apiKey = String(b.apiKey);
  if (b.timeoutMs !== undefined) updates.timeoutMs = Number(b.timeoutMs);
  if (b.copies !== undefined) updates.copies = Math.min(5, Math.max(1, Number(b.copies)));
  if (b.paperWidth !== undefined) updates.paperWidth = String(b.paperWidth);
  if (b.isActive !== undefined) updates.isActive = Boolean(b.isActive);
  const [printerRow] = await db.update(printPrintersTable)
    .set(updates as Partial<typeof printPrintersTable.$inferInsert>)
    .where(eq(printPrintersTable.id, id)).returning();
  if (!printerRow) { res.status(404).json({ error: "Printer not found" }); return; }
  res.json({ printer: printerRow });
});

// ── DELETE /api/print/printers/:id ────────────────────────────────────────
router.delete("/print/printers/:id", adminOnly, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  await db.delete(printPrintersTable).where(eq(printPrintersTable.id, id));
  res.json({ ok: true });
});

// ── POST /api/print/printers/:id/test ────────────────────────────────────
router.post("/print/printers/:id/test", adminOnly, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [printer] = await db.select().from(printPrintersTable)
    .where(eq(printPrintersTable.id, id)).limit(1);
  if (!printer) { res.status(404).json({ error: "Printer not found" }); return; }

  const testText = [
    "================================",
    "         TEST PRINT             ",
    "================================",
    `Printer: ${printer.name}`,
    `Role:    ${printer.role}`,
    `Time:    ${new Date().toLocaleString()}`,
    "================================",
    "",
    "",
  ].join("\n");

  const job = await createPrintJob({
    orderId: 0,
    printerId: printer.id,
    jobType: "order_ticket",
    payloadJson: { test: true },
    renderedText: testText,
  });

  dispatchJob(job, printer).catch(() => {});
  res.json({ ok: true, jobId: job.id });
});

// ── GET /api/print/jobs ───────────────────────────────────────────────────
router.get("/print/jobs", adminOnly, async (req, res): Promise<void> => {
  const status = req.query.status as string | undefined;
  let q = db.select().from(printJobsTable).orderBy(desc(printJobsTable.createdAt)).limit(100).$dynamic();
  if (status) {
    q = q.where(inArray(printJobsTable.status, status.split(",")));
  }
  const jobs = await q;
  res.json({ jobs });
});

// ── GET /api/print/jobs/:id ───────────────────────────────────────────────
router.get("/print/jobs/:id", adminOnly, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [job] = await db.select().from(printJobsTable)
    .where(eq(printJobsTable.id, id)).limit(1);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  const attempts = await db.select().from(printJobAttemptsTable)
    .where(eq(printJobAttemptsTable.printJobId, id))
    .orderBy(printJobAttemptsTable.attemptNumber);
  res.json({ job, attempts });
});

// ── POST /api/print/jobs/:id/retry ───────────────────────────────────────
router.post("/print/jobs/:id/retry", adminOnly, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [job] = await db.select().from(printJobsTable)
    .where(eq(printJobsTable.id, id)).limit(1);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  if (!job.printerId) { res.status(400).json({ error: "Job has no printer" }); return; }

  const [printer] = await db.select().from(printPrintersTable)
    .where(eq(printPrintersTable.id, job.printerId)).limit(1);
  if (!printer) { res.status(404).json({ error: "Printer not found" }); return; }

  await db.update(printJobsTable)
    .set({ status: "queued", retryCount: 0, errorMessage: null })
    .where(eq(printJobsTable.id, id));

  const fresh = { ...job, status: "queued", retryCount: 0, errorMessage: null };
  dispatchJob(fresh, printer).catch(() => {});
  res.json({ ok: true });
});

// ── POST /api/print/jobs/:id/reprint ─────────────────────────────────────
router.post("/print/jobs/:id/reprint", adminOnly, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [job] = await db.select().from(printJobsTable)
    .where(eq(printJobsTable.id, id)).limit(1);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  if (!job.printerId || !job.orderId) {
    res.status(400).json({ error: "Cannot reprint: missing printer or order" }); return;
  }

  const [printer] = await db.select().from(printPrintersTable)
    .where(eq(printPrintersTable.id, job.printerId)).limit(1);
  if (!printer) { res.status(404).json({ error: "Printer not found" }); return; }

  const newKey = makeIdempotencyKey(job.orderId, job.printerId, `${job.jobType}:reprint:${Date.now()}`);
  const [newJob] = await db.insert(printJobsTable).values({
    orderId: job.orderId,
    printerId: job.printerId,
    jobType: job.jobType,
    status: "queued",
    idempotencyKey: newKey,
    renderFormat: job.renderFormat,
    payloadJson: job.payloadJson as object,
    renderedText: job.renderedText,
  }).returning();

  dispatchJob(newJob, printer).catch(() => {});
  res.json({ ok: true, jobId: newJob.id });
});

// ── GET /api/print/settings ───────────────────────────────────────────────
router.get("/print/settings", adminOnly, async (_req, res): Promise<void> => {
  const settings = await getSettings();
  res.json({ settings });
});

// ── PATCH /api/print/settings ─────────────────────────────────────────────
router.patch("/print/settings", adminOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (b.autoPrintOrders !== undefined) updates.autoPrintOrders = Boolean(b.autoPrintOrders);
  if (b.autoPrintReceipts !== undefined) updates.autoPrintReceipts = Boolean(b.autoPrintReceipts);
  if (b.retryBackoffBaseMs !== undefined) updates.retryBackoffBaseMs = Number(b.retryBackoffBaseMs);
  if (b.staleJobMinutes !== undefined) updates.staleJobMinutes = Number(b.staleJobMinutes);
  const settings = await getSettings();
  const [updated] = await db.update(printSettingsTable)
    .set(updates as Partial<typeof printSettingsTable.$inferInsert>)
    .where(eq(printSettingsTable.id, settings.id)).returning();
  res.json({ settings: updated });
});

export default router;
