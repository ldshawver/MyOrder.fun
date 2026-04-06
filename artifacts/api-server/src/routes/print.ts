import { Router, type IRouter } from "express";
import { eq, desc, inArray, and } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  printPrintersTable,
  printJobsTable,
  printJobAttemptsTable,
  printSettingsTable,
  operatorPrintProfilesTable,
  printTemplatesTable,
  printAssetsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole } from "../lib/auth";
import {
  createPrintJob,
  dispatchJob,
  dispatchReceiptJob,
  dispatchLabelJob,
  getSettings,
  makeIdempotencyKey,
} from "../lib/printService";
import {
  selectActiveOperator,
  probePrinter,
  resolveReceiptPrinters,
  resolveLabelPrinter,
} from "../lib/printRouter";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

const adminOnly = requireRole("tenant_admin", "global_admin");

// ── GET /api/print/routing ─────────────────────────────────────────────────
// Returns active operator + their printers + health status. Admin monitor page.
router.get("/print/routing", adminOnly, async (_req, res): Promise<void> => {
  const operator = await selectActiveOperator();
  const profile = operator?.profile ?? null;

  const { primary: receiptPrinter, fallback: piFallback } = await resolveReceiptPrinters(profile);
  const labelPrinter = await resolveLabelPrinter(profile);

  // Probe all three in parallel
  const [receiptOnline, piOnline, labelOnline] = await Promise.all([
    receiptPrinter ? probePrinter(receiptPrinter) : Promise.resolve(null),
    piFallback ? probePrinter(piFallback) : Promise.resolve(null),
    labelPrinter ? probePrinter(labelPrinter) : Promise.resolve(null),
  ]);

  res.json({
    operator: operator
      ? {
          userId: operator.userId,
          email: operator.email,
          firstName: operator.firstName,
          lastName: operator.lastName,
          role: operator.role,
          source: operator.source,
        }
      : null,
    receiptPrinter: receiptPrinter
      ? { ...receiptPrinter, online: receiptOnline }
      : null,
    piFallback: piFallback
      ? { ...piFallback, online: piOnline }
      : null,
    labelPrinter: labelPrinter
      ? { ...labelPrinter, online: labelOnline }
      : null,
  });
});

// ── GET /api/print/health ─────────────────────────────────────────────────
router.get("/print/health", adminOnly, async (_req, res): Promise<void> => {
  const printers = await db.select().from(printPrintersTable)
    .where(eq(printPrintersTable.isActive, true));

  const results = await Promise.all(printers.map(async (p) => {
    const online = await probePrinter(p);
    return { id: p.id, name: p.name, role: p.role, connectionType: p.connectionType, online };
  }));

  res.json({ printers: results });
});

// ── GET /api/print/printers ───────────────────────────────────────────────
router.get("/print/printers", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select().from(printPrintersTable).orderBy(printPrintersTable.name);
  res.json({ printers: rows });
});

const VALID_ROLES = ["kitchen", "receipt", "expo", "label", "bar"];
const VALID_CONN_TYPES = ["ethernet_direct", "mac_bridge", "pi_bridge", "bridge"];

// ── POST /api/print/printers ──────────────────────────────────────────────
router.post("/print/printers", adminOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (!b.name) { res.status(400).json({ error: "name is required" }); return; }
  if (b.role && !VALID_ROLES.includes(b.role)) {
    res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(", ")}` }); return;
  }
  if (b.connectionType && !VALID_CONN_TYPES.includes(b.connectionType)) {
    res.status(400).json({ error: `connectionType must be one of: ${VALID_CONN_TYPES.join(", ")}` }); return;
  }
  const connType: string = b.connectionType ?? "bridge";
  const needsBridge = ["mac_bridge", "pi_bridge", "bridge"].includes(connType);
  if (needsBridge && !b.bridgeUrl) {
    res.status(400).json({ error: "bridgeUrl is required for this connectionType" }); return;
  }
  if (connType === "ethernet_direct" && !b.directIp) {
    res.status(400).json({ error: "directIp is required for ethernet_direct printers" }); return;
  }

  const [printer] = await db.insert(printPrintersTable).values({
    name: String(b.name),
    role: String(b.role ?? "kitchen"),
    connectionType: connType,
    directIp: b.directIp ? String(b.directIp) : null,
    directPort: b.directPort ? Number(b.directPort) : 9100,
    bridgeUrl: b.bridgeUrl ? String(b.bridgeUrl) : "",
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
  if (b.connectionType !== undefined) updates.connectionType = String(b.connectionType);
  if (b.directIp !== undefined) updates.directIp = b.directIp ? String(b.directIp) : null;
  if (b.directPort !== undefined) updates.directPort = Number(b.directPort);
  if (b.bridgeUrl !== undefined) updates.bridgeUrl = String(b.bridgeUrl);
  if (b.bridgePrinterName !== undefined) updates.bridgePrinterName = String(b.bridgePrinterName);
  if (b.apiKey !== undefined) updates.apiKey = String(b.apiKey);
  if (b.timeoutMs !== undefined) updates.timeoutMs = Number(b.timeoutMs);
  if (b.copies !== undefined) updates.copies = Math.min(5, Math.max(1, Number(b.copies)));
  if (b.paperWidth !== undefined) updates.paperWidth = String(b.paperWidth);
  if (b.isActive !== undefined) updates.isActive = Boolean(b.isActive);
  const [row] = await db.update(printPrintersTable)
    .set(updates as Partial<typeof printPrintersTable.$inferInsert>)
    .where(eq(printPrintersTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Printer not found" }); return; }
  res.json({ printer: row });
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
    `Type:    ${printer.connectionType}`,
    `Role:    ${printer.role}`,
    `Time:    ${new Date().toLocaleString()}`,
    "================================",
    "", "",
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

// ── POST /api/print/printers/:id/probe ───────────────────────────────────
router.post("/print/printers/:id/probe", adminOnly, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [printer] = await db.select().from(printPrintersTable)
    .where(eq(printPrintersTable.id, id)).limit(1);
  if (!printer) { res.status(404).json({ error: "Printer not found" }); return; }
  const online = await probePrinter(printer);
  res.json({ id, online });
});

// ── Operator Profiles ─────────────────────────────────────────────────────
router.get("/print/profiles", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: operatorPrintProfilesTable.id,
      userId: operatorPrintProfilesTable.userId,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
      receiptPrinterId: operatorPrintProfilesTable.receiptPrinterId,
      labelPrinterId: operatorPrintProfilesTable.labelPrinterId,
      fallbackReceiptPrinterId: operatorPrintProfilesTable.fallbackReceiptPrinterId,
      isDefault: operatorPrintProfilesTable.isDefault,
    })
    .from(operatorPrintProfilesTable)
    .innerJoin(usersTable, eq(operatorPrintProfilesTable.userId, usersTable.id))
    .orderBy(usersTable.email);
  res.json({ profiles: rows });
});

router.post("/print/profiles", adminOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (!b.userId) { res.status(400).json({ error: "userId is required" }); return; }
  const existing = await db.select().from(operatorPrintProfilesTable)
    .where(eq(operatorPrintProfilesTable.userId, Number(b.userId))).limit(1);
  if (existing.length) {
    const [updated] = await db.update(operatorPrintProfilesTable)
      .set({
        receiptPrinterId: b.receiptPrinterId ? Number(b.receiptPrinterId) : null,
        labelPrinterId: b.labelPrinterId ? Number(b.labelPrinterId) : null,
        fallbackReceiptPrinterId: b.fallbackReceiptPrinterId ? Number(b.fallbackReceiptPrinterId) : null,
        isDefault: Boolean(b.isDefault),
      })
      .where(eq(operatorPrintProfilesTable.userId, Number(b.userId)))
      .returning();
    res.json({ profile: updated });
    return;
  }
  const [profile] = await db.insert(operatorPrintProfilesTable).values({
    userId: Number(b.userId),
    receiptPrinterId: b.receiptPrinterId ? Number(b.receiptPrinterId) : null,
    labelPrinterId: b.labelPrinterId ? Number(b.labelPrinterId) : null,
    fallbackReceiptPrinterId: b.fallbackReceiptPrinterId ? Number(b.fallbackReceiptPrinterId) : null,
    isDefault: Boolean(b.isDefault),
  }).returning();
  res.status(201).json({ profile });
});

router.delete("/print/profiles/:id", adminOnly, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  await db.delete(operatorPrintProfilesTable).where(eq(operatorPrintProfilesTable.id, id));
  res.json({ ok: true });
});

// ── Templates ─────────────────────────────────────────────────────────────
router.get("/print/templates", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select().from(printTemplatesTable).orderBy(printTemplatesTable.name);
  res.json({ templates: rows });
});

router.post("/print/templates", adminOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (!b.name) { res.status(400).json({ error: "name is required" }); return; }
  const [t] = await db.insert(printTemplatesTable).values({
    name: String(b.name),
    jobType: String(b.jobType ?? "label"),
    backgroundAssetId: b.backgroundAssetId ? Number(b.backgroundAssetId) : null,
    templateJson: b.templateJson ?? [],
    paperWidth: String(b.paperWidth ?? "58mm"),
    paperHeight: String(b.paperHeight ?? "auto"),
    isActive: b.isActive !== undefined ? Boolean(b.isActive) : true,
    isDefault: Boolean(b.isDefault),
  }).returning();
  res.status(201).json({ template: t });
});

router.patch("/print/templates/:id", adminOnly, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const b = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (b.name !== undefined) updates.name = String(b.name);
  if (b.jobType !== undefined) updates.jobType = String(b.jobType);
  if (b.backgroundAssetId !== undefined) updates.backgroundAssetId = b.backgroundAssetId ? Number(b.backgroundAssetId) : null;
  if (b.templateJson !== undefined) updates.templateJson = b.templateJson;
  if (b.paperWidth !== undefined) updates.paperWidth = String(b.paperWidth);
  if (b.paperHeight !== undefined) updates.paperHeight = String(b.paperHeight);
  if (b.isActive !== undefined) updates.isActive = Boolean(b.isActive);
  if (b.isDefault !== undefined) updates.isDefault = Boolean(b.isDefault);
  const [t] = await db.update(printTemplatesTable)
    .set(updates as Partial<typeof printTemplatesTable.$inferInsert>)
    .where(eq(printTemplatesTable.id, id)).returning();
  if (!t) { res.status(404).json({ error: "Template not found" }); return; }
  res.json({ template: t });
});

router.delete("/print/templates/:id", adminOnly, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  await db.delete(printTemplatesTable).where(eq(printTemplatesTable.id, id));
  res.json({ ok: true });
});

// ── Jobs ──────────────────────────────────────────────────────────────────
router.get("/print/jobs", adminOnly, async (req, res): Promise<void> => {
  const status = req.query.status as string | undefined;
  let q = db.select().from(printJobsTable).orderBy(desc(printJobsTable.createdAt)).limit(200).$dynamic();
  if (status && status !== "all") {
    q = q.where(inArray(printJobsTable.status, status.split(",")));
  }
  const jobs = await q;
  res.json({ jobs });
});

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
    operatorUserId: job.operatorUserId ?? null,
  }).returning();

  dispatchJob(newJob, printer).catch(() => {});
  res.json({ ok: true, jobId: newJob.id });
});

// ── Settings ──────────────────────────────────────────────────────────────
router.get("/print/settings", adminOnly, async (_req, res): Promise<void> => {
  const settings = await getSettings();
  res.json({ settings });
});

router.patch("/print/settings", adminOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (b.autoPrintOrders !== undefined) updates.autoPrintOrders = Boolean(b.autoPrintOrders);
  if (b.autoPrintReceipts !== undefined) updates.autoPrintReceipts = Boolean(b.autoPrintReceipts);
  if (b.autoPrintLabels !== undefined) updates.autoPrintLabels = Boolean(b.autoPrintLabels);
  if (b.retryBackoffBaseMs !== undefined) updates.retryBackoffBaseMs = Number(b.retryBackoffBaseMs);
  if (b.staleJobMinutes !== undefined) updates.staleJobMinutes = Number(b.staleJobMinutes);
  if (b.alertOnLabelFailure !== undefined) updates.alertOnLabelFailure = Boolean(b.alertOnLabelFailure);
  const settings = await getSettings();
  const [updated] = await db.update(printSettingsTable)
    .set(updates as Partial<typeof printSettingsTable.$inferInsert>)
    .where(eq(printSettingsTable.id, settings.id)).returning();
  res.json({ settings: updated });
});

// ── Users list (for profile assignment) ───────────────────────────────────
router.get("/print/users", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select({
    id: usersTable.id,
    email: usersTable.email,
    firstName: usersTable.firstName,
    lastName: usersTable.lastName,
    role: usersTable.role,
  }).from(usersTable).where(eq(usersTable.isActive, true)).orderBy(usersTable.email);
  res.json({ users: rows });
});

export default router;
