import { Router, type IRouter } from "express";
import { eq, desc, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  renderBlocks,
  buildCustomerReceiptBlocks,
  buildInventoryStartBlocks,
  buildInventoryEndBlocks,
  buildLabelBlocks,
  getLogo,
  charWidth,
} from "../lib/print/index";
import {
  printPrintersTable,
  printBridgeProfilesTable,
  printJobsTable,
  printJobAttemptsTable,
  printSettingsTable,
  operatorPrintProfilesTable,
  printTemplatesTable,
  usersTable,
  ordersTable,
  orderItemsTable,
  adminSettingsTable,
} from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import {
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
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const adminOnly = requireRole("admin", "supervisor");

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
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
  const b = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (b.name !== undefined) updates.name = String(b.name);
  if (b.role !== undefined) updates.role = String(b.role);
  if (b.connectionType !== undefined) updates.connectionType = String(b.connectionType);
  if (b.bridgeProfileId !== undefined) updates.bridgeProfileId = b.bridgeProfileId ? Number(b.bridgeProfileId) : null;
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
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
  await db.delete(printPrintersTable).where(eq(printPrintersTable.id, id));
  res.json({ ok: true });
});

// ── POST /api/print/printers/:id/test ────────────────────────────────────
// Synchronous — awaits dispatch and returns the real pass/fail result.
router.post("/print/printers/:id/test", adminOnly, async (req, res): Promise<void> => {
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
  const [printer] = await db.select().from(printPrintersTable)
    .where(eq(printPrintersTable.id, id)).limit(1);
  if (!printer) { res.status(404).json({ error: "Printer not found" }); return; }

  const bridgePrinterName = printer.bridgePrinterName ?? printer.name;
  const testText = [
    "================================",
    "         TEST PRINT             ",
    "================================",
    `Printer : ${printer.name}`,
    `Queue   : ${bridgePrinterName}`,
    `Type    : ${printer.connectionType}`,
    `Role    : ${printer.role}`,
    `Bridge  : ${printer.bridgeUrl || "(none)"}`,
    `Time    : ${new Date().toLocaleString()}`,
    "================================",
    "", "",
  ].join("\n");

  // Use a unique idempotency key so repeated test presses each create a new job
  const iKey = `test:${printer.id}:${Date.now()}`;
  const [job] = await db.insert(printJobsTable).values({
    orderId: null,
    printerId: printer.id,
    jobType: "order_ticket",
    status: "queued",
    idempotencyKey: iKey,
    renderFormat: "text",
    payloadJson: { test: true, printerName: bridgePrinterName },
    renderedText: testText,
  }).returning();

  // Await the full dispatch so we can report the actual result
  await dispatchJob(job, printer).catch(() => {});

  // Re-fetch the job to get final status + error
  const [finalJob] = await db.select().from(printJobsTable)
    .where(eq(printJobsTable.id, job.id)).limit(1);
  const ok = finalJob?.status === "printed";

  res.json({
    ok,
    jobId: job.id,
    status: finalJob?.status ?? "unknown",
    error: ok ? undefined : (finalJob?.errorMessage ?? "Print job did not complete"),
  });
});

// ── POST /api/print/printers/:id/probe ───────────────────────────────────
router.post("/print/printers/:id/probe", adminOnly, async (req, res): Promise<void> => {
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
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
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
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
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
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
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
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
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
  const [job] = await db.select().from(printJobsTable)
    .where(eq(printJobsTable.id, id)).limit(1);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  const attempts = await db.select().from(printJobAttemptsTable)
    .where(eq(printJobAttemptsTable.printJobId, id))
    .orderBy(printJobAttemptsTable.attemptNumber);
  res.json({ job, attempts });
});

router.post("/print/jobs/:id/retry", adminOnly, async (req, res): Promise<void> => {
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
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
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
  const [job] = await db.select().from(printJobsTable)
    .where(eq(printJobsTable.id, id)).limit(1);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  if (!job.printerId) {
    res.status(400).json({ error: "Cannot reprint: no printer assigned to this job" }); return;
  }

  const [printer] = await db.select().from(printPrintersTable)
    .where(eq(printPrintersTable.id, job.printerId)).limit(1);
  if (!printer) { res.status(404).json({ error: "Printer not found" }); return; }

  // Use orderId if present; test jobs have orderId=null so fall back to job id
  const keyOrderId = job.orderId ?? job.id * -1;
  const newKey = makeIdempotencyKey(keyOrderId, job.printerId, `${job.jobType}:reprint:${Date.now()}`);
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
  if (b.includeLogo !== undefined) updates.includeLogo = Boolean(b.includeLogo);
  if (b.includeOperatorName !== undefined) updates.includeOperatorName = Boolean(b.includeOperatorName);
  if (b.showDiscreetNotice !== undefined) updates.showDiscreetNotice = Boolean(b.showDiscreetNotice);
  if (b.paperWidth !== undefined) updates.paperWidth = String(b.paperWidth);
  if (b.brandName !== undefined) updates.brandName = b.brandName ? String(b.brandName) : null;
  if (b.footerMessage !== undefined) updates.footerMessage = b.footerMessage ? String(b.footerMessage) : null;
  const settings = await getSettings();
  const [updated] = await db.update(printSettingsTable)
    .set(updates as Partial<typeof printSettingsTable.$inferInsert>)
    .where(eq(printSettingsTable.id, settings.id)).returning();
  res.json({ settings: updated });
});

// ── Print Previews ─────────────────────────────────────────────────────────
// Returns rendered plain-text for browser preview and test-dispatch review.

router.post("/print/preview/receipt", adminOnly, async (req, res): Promise<void> => {
  const settings = await getSettings();
  const s = settings as Record<string, unknown>;
  const width = charWidth(s.paperWidth as string ?? "80mm");
  const dualBrandName = s.brandName as string | undefined;
  const logoLines = s.includeLogo !== false ? getLogo(width) : [];
  const body = req.body ?? {};
  const blocks = buildCustomerReceiptBlocks({
    orderId: body.orderId ?? 0,
    orderNumber: body.orderNumber ?? "PREVIEW",
    createdAt: body.createdAt ?? new Date(),
    customerName: body.customerName ?? "Preview Customer",
    fulfillmentType: body.fulfillmentType ?? "Pickup",
    operatorName: body.operatorName,
    paymentStatus: body.paymentStatus ?? "paid",
    paymentMethod: body.paymentMethod ?? "Cash",
    notes: body.notes,
    items: body.items ?? [
      { name: "Blue Dream 3.5g",    quantity: 1, unitPrice: 45.00, totalPrice: 45.00 },
      { name: "House Special",      quantity: 2, unitPrice: 30.00, totalPrice: 60.00, notes: "Extra discreet packaging" },
    ],
    subtotal: body.subtotal ?? 105.00,
    tax: body.tax ?? 0,
    total: body.total ?? 105.00,
    logoLines,
    dualBrandName,
    footerMessage: s.footerMessage as string | undefined,
    showDiscreetNotice: Boolean(s.showDiscreetNotice),
    showOperatorName: s.includeOperatorName !== false,
  });
  res.type("text/plain").send(renderBlocks(blocks, width));
});

router.post("/print/preview/inventory-start", adminOnly, async (req, res): Promise<void> => {
  const settings = await getSettings();
  const s = settings as Record<string, unknown>;
  const width = charWidth(s.paperWidth as string ?? "80mm");
  const logoLines = s.includeLogo !== false ? getLogo(width) : [];
  const body = req.body ?? {};
  const blocks = buildInventoryStartBlocks({
    shiftId: body.shiftId ?? "PREVIEW",
    operatorName: body.operatorName ?? "Preview Operator",
    clockedInAt: body.clockedInAt ?? new Date(),
    tenantName: body.tenantName,
    items: body.items ?? [
      { rowType: "section", sectionName: "Sample Section", itemName: "Sample Section", unitType: "#", quantityStart: 0 },
      { rowType: "item", itemName: "Sample Item", unitType: "#", quantityStart: 10 },
    ],
    logoLines,
    footerMessage: s.footerMessage as string | undefined,
  });
  res.type("text/plain").send(renderBlocks(blocks, width));
});

router.post("/print/preview/inventory-end", adminOnly, async (req, res): Promise<void> => {
  const settings = await getSettings();
  const s = settings as Record<string, unknown>;
  const width = charWidth(s.paperWidth as string ?? "80mm");
  const logoLines = s.includeLogo !== false ? getLogo(width) : [];
  const body = req.body ?? {};
  const blocks = buildInventoryEndBlocks({
    shiftId: body.shiftId ?? "PREVIEW",
    operatorName: body.operatorName ?? "Preview Operator",
    clockedInAt: body.clockedInAt ?? new Date(Date.now() - 3600000),
    clockedOutAt: body.clockedOutAt ?? new Date(),
    tenantName: body.tenantName,
    items: body.items ?? [
      { rowType: "section", sectionName: "Sample Section", itemName: "Sample Section", unitType: "#", quantityStart: 0, quantitySold: 0, quantityEnd: 0 },
      { rowType: "item", itemName: "Sample Item", unitType: "#", quantityStart: 10, quantitySold: 3, quantityEnd: 7 },
    ],
    totalSales: body.totalSales,
    pettyCash: body.pettyCash,
    notes: body.notes,
    logoLines,
    footerMessage: (settings as Record<string, unknown>).footerMessage as string | undefined,
  });
  res.type("text/plain").send(renderBlocks(blocks, width));
});

router.post("/print/preview/label", adminOnly, async (req, res): Promise<void> => {
  const settings = await getSettings();
  const width = charWidth((settings as Record<string, unknown>).paperWidth as string ?? "80mm");
  const body = req.body ?? {};
  const blocks = buildLabelBlocks({
    title: body.title ?? "PRODUCT LABEL",
    line1: body.line1 ?? "Sample Product",
    line2: body.line2,
    line3: body.line3,
    barcode: body.barcode,
    footer: body.footer,
  });
  res.type("text/plain").send(renderBlocks(blocks, width));
});

// ── Thank You Label (PNG image) ────────────────────────────────────────────
// GET  /api/print/preview/thank-you-label?name=<firstName>
//   Returns a PNG image of the personalized sticker for browser preview.
// POST /api/print/label/thank-you
//   Body: { firstName, copies? }
//   Generates label, dispatches to the label printer, returns job info.

router.get("/print/preview/thank-you-label", adminOnly, async (req, res): Promise<void> => {
  const { generateThankYouLabel } = await import("../lib/print/templates/thankYouLabel.js");
  const firstName = String(req.query.name ?? "Friend");
  try {
    const buf = await generateThankYouLabel(firstName);
    res.type("image/png").send(buf);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/print/label/thank-you", adminOnly, async (req, res): Promise<void> => {
  const { generateThankYouLabel } = await import("../lib/print/templates/thankYouLabel.js");
  const b = req.body ?? {};
  const firstName = String(b.firstName ?? "Friend").trim().slice(0, 20) || "Friend";
  const copies    = Math.min(5, Math.max(1, parseInt(String(b.copies ?? 1), 10)));

  // Resolve label printer
  const operator   = await selectActiveOperator();
  const labelPrinter = await resolveLabelPrinter(operator?.profile ?? null);
  if (!labelPrinter) {
    res.status(503).json({ error: "No label printer configured" });
    return;
  }

  // Generate PNG
  let pngBuf: Buffer;
  try {
    pngBuf = await generateThankYouLabel(firstName);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Image generation failed: ${msg}` });
    return;
  }

  const iKey = `thank-you-label:${firstName}:${Date.now()}`;
  const [job] = await db.insert(printJobsTable).values({
    orderId: null,
    printerId: labelPrinter.id,
    jobType: "label",
    status: "queued",
    idempotencyKey: iKey,
    renderFormat: "png",
    payloadJson: {
      labelType: "thank-you",
      customerFirstName: firstName,
      imageData: pngBuf.toString("base64"),
    },
    renderedText: `Thank You label — ${firstName}`,
  }).returning();

  // Dispatch and await result
  await dispatchJob(job, labelPrinter).catch(() => {});

  const [finalJob] = await db.select().from(printJobsTable)
    .where(eq(printJobsTable.id, job.id)).limit(1);

  if (copies > 1) {
    // Additional copies: fire-and-forget
    for (let i = 1; i < copies; i++) {
      const extraKey = `thank-you-label:${firstName}:${Date.now()}:copy${i}`;
      const [extraJob] = await db.insert(printJobsTable).values({
        orderId: null,
        printerId: labelPrinter.id,
        jobType: "label",
        status: "queued",
        idempotencyKey: extraKey,
        renderFormat: "png",
        payloadJson: {
          labelType: "thank-you",
          customerFirstName: firstName,
          imageData: pngBuf.toString("base64"),
        },
        renderedText: `Thank You label — ${firstName} (copy ${i + 1})`,
      }).returning();
      dispatchJob(extraJob, labelPrinter).catch(() => {});
    }
  }

  res.json({
    ok: finalJob?.status === "printed",
    jobId: job.id,
    status: finalJob?.status ?? "unknown",
    firstName,
    printerName: labelPrinter.name,
    error: finalJob?.status === "printed"
      ? undefined
      : (finalJob?.errorMessage ?? "Job did not complete"),
  });
});

// ── Per-order print triggers (any approved user) ──────────────────────────
// Called from the staff CSR queue when a rep manually hits "Print Receipt"
// or "Print Label". Does NOT require adminOnly — business_sitter / CSR role
// is enough (router-level middleware already requires auth + approved).

/** POST /api/print/orders/:id/receipt — reprint/trigger receipt for an order */
router.post("/print/orders/:id/receipt", async (req, res): Promise<void> => {
<<<<<<< HEAD
  const orderId = parseInt(req.params.id as string, 10);
=======
  const orderId = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }

  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }

  const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, orderId));

  const [customer] = await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable).where(eq(usersTable.id, order.customerId)).limit(1);
  const customerName = customer ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() : "";

  const operator = await selectActiveOperator();
  const { primary: receiptPrinter } = await resolveReceiptPrinters(operator?.profile ?? null);
  if (!receiptPrinter) {
    res.status(503).json({ error: "No receipt printer configured or available" });
    return;
  }

  let receiptLineNameMode: "alavont_only" | "lucifer_only" | "both" = "lucifer_only";
  try {
    const [adminSettings] = await db.select({ receiptLineNameMode: adminSettingsTable.receiptLineNameMode })
      .from(adminSettingsTable).limit(1);
    if (adminSettings?.receiptLineNameMode) {
      receiptLineNameMode = adminSettings.receiptLineNameMode as typeof receiptLineNameMode;
    }
  } catch { /* non-critical */ }

  const settings = await getSettings();
  const s = settings as Record<string, unknown>;
  const width = charWidth(s.paperWidth as string ?? "80mm");
  const logoLines = s.includeLogo !== false ? getLogo(width) : [];
  const operatorName = operator
    ? (`${operator.firstName ?? ""} ${operator.lastName ?? ""}`).trim() || operator.email || undefined
    : undefined;

  const printOrder = {
    id: order.id,
    customerName,
    notes: order.notes ?? undefined,
    receiptLineNameMode,
    items: items.map(i => ({
      quantity: i.quantity,
      name: i.catalogItemName,
      alavontName: i.alavontName ?? i.catalogItemName,
      luciferCruzName: i.luciferCruzName ?? i.catalogItemName,
      unitPrice: parseFloat(i.unitPrice as string),
      totalPrice: parseFloat(i.totalPrice as string),
    })),
    subtotal: parseFloat(order.subtotal as string),
    tax: parseFloat((order.tax as string) ?? "0"),
    total: parseFloat(order.total as string),
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
    logoLines,
    dualBrandName: s.brandName as string | undefined,
    footerMessage: s.footerMessage as string | undefined,
    showDiscreetNotice: Boolean(s.showDiscreetNotice),
    showOperatorName: s.includeOperatorName !== false,
    operatorName,
  };

  const { renderCustomerReceipt } = await import("../lib/receiptRenderer.js");
  const renderedText = renderCustomerReceipt(printOrder);

  // Always create a fresh job for reprints (unique key per timestamp)
  const iKey = makeIdempotencyKey(orderId, receiptPrinter.id, `receipt:reprint:${Date.now()}`);
  const [job] = await db.insert(printJobsTable).values({
    orderId,
    printerId: receiptPrinter.id,
    jobType: "receipt",
    status: "queued",
    idempotencyKey: iKey,
    renderFormat: "text",
    payloadJson: printOrder as object,
    renderedText,
    operatorUserId: operator?.userId ?? null,
  }).returning();

  await dispatchReceiptJob(job, receiptPrinter).catch(() => {});

  const [finalJob] = await db.select().from(printJobsTable).where(eq(printJobsTable.id, job.id)).limit(1);
  const ok = finalJob?.status === "printed";

  res.json({
    ok,
    jobId: job.id,
    status: finalJob?.status ?? "unknown",
    printerName: receiptPrinter.name,
    error: ok ? undefined : (finalJob?.errorMessage ?? "Receipt print did not complete"),
  });
});

/** POST /api/print/orders/:id/label — print delivery label with customer name */
router.post("/print/orders/:id/label", async (req, res): Promise<void> => {
<<<<<<< HEAD
  const orderId = parseInt(req.params.id as string, 10);
=======
  const orderId = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
  if (isNaN(orderId)) { res.status(400).json({ error: "Invalid order id" }); return; }

  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }

  const [customer] = await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable).where(eq(usersTable.id, order.customerId)).limit(1);
  const customerName = customer ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() : "Customer";
  const firstName = customer?.firstName?.trim() || customerName;

  const operator = await selectActiveOperator();
  const labelPrinter = await resolveLabelPrinter(operator?.profile ?? null);
  if (!labelPrinter) {
    res.status(503).json({ error: "No label printer configured" });
    return;
  }

  const settings = await getSettings();
  const s = settings as Record<string, unknown>;
  // Labels default to 58mm paper
  const width = charWidth((s.paperWidth as string ?? "58mm"));

  // Delivery label: customer first name is the headline, order details below
  const blocks = buildLabelBlocks({
    title: firstName.toUpperCase(),
    line1: `Order #${orderId}`,
    line2: order.shippingAddress ?? undefined,
    line3: `Total: $${parseFloat(order.total as string).toFixed(2)}`,
    footer: new Date(order.createdAt).toLocaleTimeString(),
  });
  const renderedText = renderBlocks(blocks, width);

  const iKey = makeIdempotencyKey(orderId, labelPrinter.id, `label:reprint:${Date.now()}`);
  const [job] = await db.insert(printJobsTable).values({
    orderId,
    printerId: labelPrinter.id,
    jobType: "label",
    status: "queued",
    idempotencyKey: iKey,
    renderFormat: "text",
    payloadJson: { orderId, customerName, firstName, shippingAddress: order.shippingAddress ?? null },
    renderedText,
    operatorUserId: operator?.userId ?? null,
  }).returning();

  await dispatchLabelJob(job, labelPrinter).catch(() => {});

  const [finalJob] = await db.select().from(printJobsTable).where(eq(printJobsTable.id, job.id)).limit(1);
  const ok = finalJob?.status === "printed";

  res.json({
    ok,
    jobId: job.id,
    status: finalJob?.status ?? "unknown",
    printerName: labelPrinter.name,
    customerName,
    error: ok ? undefined : (finalJob?.errorMessage ?? "Label print did not complete"),
  });
});

// ── Bridge Diagnostics ────────────────────────────────────────────────────
// These routes let the admin UI directly test bridge connectivity and get
// the bridge's own printer list — without going through a print job.

/** GET /api/print/bridge/health?printerId=<id>  — or defaults to first active bridge printer */
router.get("/print/bridge/health", adminOnly, async (req, res): Promise<void> => {
  const pid = req.query.printerId ? parseInt(String(req.query.printerId), 10) : null;
  const printerRows = pid
    ? await db.select().from(printPrintersTable).where(eq(printPrintersTable.id, pid)).limit(1)
    : await db.select().from(printPrintersTable).where(eq(printPrintersTable.isActive, true)).limit(1);
  const printer: typeof printPrintersTable.$inferSelect | null = printerRows[0] ?? null;

  if (!printer) { res.status(404).json({ error: "No printer found" }); return; }

  const apiKey = printer.apiKey ?? process.env.PRINT_BRIDGE_API_KEY ?? "";
  const bridgeUrl = printer.bridgeUrl;
  const TIMEOUT_MS = 5000;

  if (!bridgeUrl) { res.json({ ok: false, error: "Bridge URL not set on this printer" }); return; }
  if (!apiKey)    { res.json({ ok: false, error: "API key not set on this printer" }); return; }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const r = await fetch(`${bridgeUrl}/health`, {
      headers: { "x-api-key": apiKey },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    let body: unknown;
    try { body = await r.json(); } catch { body = null; }

    res.json({
      ok: r.ok && (body as { status?: string })?.status === "ok",
      httpStatus: r.status,
      bridgeUrl,
      printerName: printer.bridgePrinterName ?? printer.name,
      hasApiKey: Boolean(apiKey),
      body,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes("AbortError") || (err instanceof Error && err.name === "AbortError");
    res.json({
      ok: false,
      bridgeUrl,
      hasApiKey: Boolean(apiKey),
      error: isTimeout
        ? `Timed out after ${TIMEOUT_MS}ms — bridge unreachable (check Tailscale connection)`
        : `Connection failed: ${msg}`,
    });
  }
});

/** GET /api/print/bridge/printers?printerId=<id>  — list bridge's known printer queues */
router.get("/print/bridge/printers", adminOnly, async (req, res): Promise<void> => {
  const pid = req.query.printerId ? parseInt(String(req.query.printerId), 10) : null;
  const printerRows = pid
    ? await db.select().from(printPrintersTable).where(eq(printPrintersTable.id, pid)).limit(1)
    : await db.select().from(printPrintersTable).where(eq(printPrintersTable.isActive, true)).limit(1);
  const printer: typeof printPrintersTable.$inferSelect | null = printerRows[0] ?? null;

  if (!printer) { res.status(404).json({ error: "No printer found" }); return; }

  const apiKey = printer.apiKey ?? process.env.PRINT_BRIDGE_API_KEY ?? "";
  const bridgeUrl = printer.bridgeUrl;
  const TIMEOUT_MS = 5000;

  if (!bridgeUrl) { res.json({ ok: false, error: "Bridge URL not set on this printer" }); return; }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const r = await fetch(`${bridgeUrl}/printers`, {
      headers: apiKey ? { "x-api-key": apiKey } : {},
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    let body: unknown;
    try { body = await r.json(); } catch { body = null; }
    res.json({ ok: r.ok, httpStatus: r.status, bridgeUrl, body });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    res.json({
      ok: false,
      bridgeUrl,
      error: isTimeout
        ? `Timed out after ${TIMEOUT_MS}ms — bridge unreachable`
        : `Connection failed: ${msg}`,
    });
  }
});

// ── Bridge Profiles CRUD ──────────────────────────────────────────────────────

/** GET /api/print/bridge-profiles — list all bridge profiles */
router.get("/print/bridge-profiles", adminOnly, async (_req, res): Promise<void> => {
  const profiles = await db.select().from(printBridgeProfilesTable).orderBy(printBridgeProfilesTable.priority);
  res.json(profiles);
});

/** POST /api/print/bridge-profiles — create a bridge profile */
router.post("/print/bridge-profiles", adminOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  if (!b.name || !b.bridgeUrl) { res.status(400).json({ error: "name and bridgeUrl are required" }); return; }
  const [row] = await db.insert(printBridgeProfilesTable).values({
    name: String(b.name),
    bridgeType: String(b.bridgeType ?? "generic"),
    bridgeUrl: String(b.bridgeUrl),
    apiKey: String(b.apiKey ?? ""),
    isActive: b.isActive !== false,
    priority: Number(b.priority ?? 10),
    networkSubnetHint: b.networkSubnetHint ? String(b.networkSubnetHint) : null,
    supportedRoles: String(b.supportedRoles ?? "both"),
    notes: b.notes ? String(b.notes) : null,
  }).returning();
  res.status(201).json(row);
});

/** PATCH /api/print/bridge-profiles/:id — update a bridge profile */
router.patch("/print/bridge-profiles/:id", adminOnly, async (req, res): Promise<void> => {
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
  const b = req.body ?? {};
  const updates: Partial<typeof printBridgeProfilesTable.$inferInsert> = {};
  if (b.name !== undefined) updates.name = String(b.name);
  if (b.bridgeType !== undefined) updates.bridgeType = String(b.bridgeType);
  if (b.bridgeUrl !== undefined) updates.bridgeUrl = String(b.bridgeUrl);
  if (b.apiKey !== undefined) updates.apiKey = String(b.apiKey);
  if (b.isActive !== undefined) updates.isActive = Boolean(b.isActive);
  if (b.priority !== undefined) updates.priority = Number(b.priority);
  if (b.networkSubnetHint !== undefined) updates.networkSubnetHint = b.networkSubnetHint ? String(b.networkSubnetHint) : null;
  if (b.supportedRoles !== undefined) updates.supportedRoles = String(b.supportedRoles);
  if (b.notes !== undefined) updates.notes = b.notes ? String(b.notes) : null;
  const [row] = await db.update(printBridgeProfilesTable).set(updates).where(eq(printBridgeProfilesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Bridge profile not found" }); return; }
  res.json(row);
});

/** DELETE /api/print/bridge-profiles/:id */
router.delete("/print/bridge-profiles/:id", adminOnly, async (req, res): Promise<void> => {
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
  await db.delete(printBridgeProfilesTable).where(eq(printBridgeProfilesTable.id, id));
  res.json({ success: true });
});

/** POST /api/print/bridge-profiles/:id/probe — health check a bridge profile */
router.post("/print/bridge-profiles/:id/probe", adminOnly, async (req, res): Promise<void> => {
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
  const rows = await db.select().from(printBridgeProfilesTable).where(eq(printBridgeProfilesTable.id, id)).limit(1);
  const profile = rows[0];
  if (!profile) { res.status(404).json({ error: "Bridge profile not found" }); return; }

  const TIMEOUT_MS = 5000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const r = await fetch(`${profile.bridgeUrl}/health`, {
      headers: { "x-api-key": profile.apiKey },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    let body: unknown;
    try { body = await r.json(); } catch { body = null; }
    res.json({
      ok: r.ok && (body as { status?: string })?.status === "ok",
      httpStatus: r.status,
      bridgeUrl: profile.bridgeUrl,
      body,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    res.json({
      ok: false,
      bridgeUrl: profile.bridgeUrl,
      error: isTimeout
        ? `Timed out after ${TIMEOUT_MS}ms — bridge unreachable`
        : `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

/** POST /api/print/bridge-profiles/:id/list-printers — list CUPS printers on a bridge */
router.post("/print/bridge-profiles/:id/list-printers", adminOnly, async (req, res): Promise<void> => {
<<<<<<< HEAD
  const id = parseInt(req.params.id as string, 10);
=======
  const id = parseInt(String(req.params.id), 10);
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
  const rows = await db.select().from(printBridgeProfilesTable).where(eq(printBridgeProfilesTable.id, id)).limit(1);
  const profile = rows[0];
  if (!profile) { res.status(404).json({ error: "Bridge profile not found" }); return; }

  const TIMEOUT_MS = 5000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const r = await fetch(`${profile.bridgeUrl}/printers`, {
      headers: { "x-api-key": profile.apiKey },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    let body: unknown;
    try { body = await r.json(); } catch { body = null; }
    res.json({ ok: r.ok, httpStatus: r.status, bridgeUrl: profile.bridgeUrl, body });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    res.json({
      ok: false,
      bridgeUrl: profile.bridgeUrl,
      error: isTimeout ? `Timed out after ${TIMEOUT_MS}ms` : `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

/** GET /api/print/routing/decision — show current routing decision for a test order */
router.get("/print/routing/decision", adminOnly, async (req, res): Promise<void> => {
  const { resolveRoutingDecision, getActiveOperatorIp } = await import("../lib/printRoutingResolver.js");
  const role = (req.query.role as string) === "label" ? "label" : "receipt";
  const tenantId = req.query.tenantId ? parseInt(String(req.query.tenantId), 10) : undefined;
  const fulfillmentType = req.query.fulfillmentType ? String(req.query.fulfillmentType) : undefined;
  const shippingAddress = req.query.shippingAddress ? String(req.query.shippingAddress) : undefined;

  const operatorIp = await getActiveOperatorIp();
  const decision = await resolveRoutingDecision(
    role,
    { id: 0, tenantId, fulfillmentType, shippingAddress },
    operatorIp
  );
  res.json({ operatorIp, decision });
});

/** POST /api/print/printers/seed-defaults — upsert the two known-good Tailscale bridge printers */
router.post("/print/printers/seed-defaults", adminOnly, async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const bridgeUrl = String(body.bridgeUrl ?? "http://100.103.51.63:3100");
  const apiKey    = String(body.apiKey ?? "");

  const defaults = [
    {
      name: "Reciept_POS80_Printer",
      role: "receipt",
      connectionType: "bridge" as const,
      bridgeUrl,
      bridgePrinterName: "Reciept_POS80_Printer",
      apiKey: apiKey || null,
      isActive: true,
      paperWidth: "80mm",
      timeoutMs: 8000,
      copies: 1,
    },
    {
      name: "Label_Themal_Printer",
      role: "label",
      connectionType: "bridge" as const,
      bridgeUrl,
      bridgePrinterName: "Label_Themal_Printer",
      apiKey: apiKey || null,
      isActive: true,
      paperWidth: "58mm",
      timeoutMs: 8000,
      copies: 1,
    },
  ];

  const results = [];
  for (const d of defaults) {
    // Try to find existing by bridgePrinterName + role
    const existing = await db.select().from(printPrintersTable)
      .where(eq(printPrintersTable.name, d.name)).limit(1);

    if (existing.length) {
      const updates: Record<string, unknown> = {
        role: d.role,
        connectionType: d.connectionType,
        bridgeUrl: d.bridgeUrl,
        bridgePrinterName: d.bridgePrinterName,
        isActive: d.isActive,
        paperWidth: d.paperWidth,
        timeoutMs: d.timeoutMs,
      };
      if (d.apiKey) updates.apiKey = d.apiKey;

      const [updated] = await db.update(printPrintersTable)
        .set(updates)
        .where(eq(printPrintersTable.id, existing[0].id))
        .returning();
      results.push({ action: "updated", id: updated.id, name: updated.name, role: updated.role });
    } else {
      const [inserted] = await db.insert(printPrintersTable).values(d).returning();
      results.push({ action: "created", id: inserted.id, name: inserted.name, role: inserted.role });
    }
  }

  res.json({ ok: true, bridgeUrl, results });
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
