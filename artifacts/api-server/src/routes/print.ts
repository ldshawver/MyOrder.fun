import { Router, type IRouter, type Request } from "express";
import { eq, desc, inArray, and, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  renderBlocks,
  renderBodyOnly,
  buildCustomerReceiptBlocks,
  buildInventoryStartBlocks,
  buildInventoryEndBlocks,
  buildLabelBlocks,
  getLogo,
  charWidth,
} from "../lib/print/index";
import { printReceiptEscPos } from "../lib/escposPrinter";
import {
  printPrintersTable,
  printBridgeProfilesTable,
  printJobsTable,
  printJobAttemptsTable,
  printSettingsTable,
  operatorPrintProfilesTable,
  printTemplatesTable,
  printAssetsTable,
  usersTable,
  ordersTable,
  orderItemsTable,
  adminSettingsTable,
  auditLogsTable,
  printTemplateVersionsTable,
  inventoryLocationsTable,
  shiftPrintAssignmentsTable,
} from "@workspace/db";
import {
  requireAuth,
  loadDbUser,
  requireDbUser,
  requireRole,
  requireApproved,
} from "../lib/auth";
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
  resolveBridgeApiKey,
} from "../lib/printRouter";
import { receiptTemplateLayoutSchema } from "../lib/printTemplateSchema";
import multer from "multer";
import sharp from "sharp";
import crypto from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const adminOnly = requireRole("global_admin", "admin");
const requestTenantId = (req: Request): number => {
  const tenantId = req.dbUser?.tenantId;
  if (!tenantId) throw new Error("Approved tenant membership is required");
  return tenantId;
};
const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
const assetRoot = resolve(
  process.env.PRINT_ASSET_DIR ?? "/var/lib/myorder/print-assets",
);
const rasterFormats = new Map([
  ["png", ["image/png", "png"]],
  ["jpeg", ["image/jpeg", "jpg"]],
  ["webp", ["image/webp", "webp"]],
] as const);

router.get("/print/assets", adminOnly, async (req, res): Promise<void> => {
  const assets = await db
    .select()
    .from(printAssetsTable)
    .where(
      and(
        eq(printAssetsTable.tenantId, requestTenantId(req)),
        eq(printAssetsTable.isActive, true),
      ),
    )
    .orderBy(desc(printAssetsTable.createdAt));
  res.json({ assets });
});

router.post(
  "/print/assets",
  adminOnly,
  assetUpload.single("file"),
  async (req, res): Promise<void> => {
    const tenantId = requestTenantId(req);
    if (!req.file) {
      res.status(400).json({ error: "A raster image file is required" });
      return;
    }
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(req.file.buffer, { failOn: "error" }).metadata();
    } catch {
      res
        .status(400)
        .json({ error: "File content is not a valid supported raster image" });
      return;
    }
    const format = metadata.format
      ? rasterFormats.get(metadata.format as "png" | "jpeg" | "webp")
      : undefined;
    if (
      !format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 4096 ||
      metadata.height > 4096
    ) {
      res
        .status(400)
        .json({
          error: "Only PNG, JPEG, or WebP images up to 4096×4096 are allowed",
        });
      return;
    }
    if (req.file.mimetype !== format[0]) {
      res
        .status(400)
        .json({ error: "Declared MIME type does not match file content" });
      return;
    }
    const digest = crypto
      .createHash("sha256")
      .update(req.file.buffer)
      .digest("hex");
    const relativePath = join(String(tenantId), `${digest}.${format[1]}`);
    const tenantDir = join(assetRoot, String(tenantId));
    await mkdir(tenantDir, { recursive: true, mode: 0o750 });
    await writeFile(join(assetRoot, relativePath), req.file.buffer, {
      mode: 0o640,
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const [asset] = await db
      .insert(printAssetsTable)
      .values({
        tenantId,
        filename: `${digest}.${format[1]}`,
        originalName: req.file.originalname.slice(0, 255),
        mimeType: format[0],
        sizeBytes: req.file.size,
        storagePath: relativePath,
        contentSha256: digest,
        widthPx: metadata.width,
        heightPx: metadata.height,
        createdByUserId: req.dbUser!.id,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [printAssetsTable.tenantId, printAssetsTable.contentSha256],
        set: { isActive: true },
      })
      .returning();
    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_ASSET_UPLOADED",
        resourceType: "print_asset",
        resourceId: String(asset.id),
        metadata: {
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          widthPx: asset.widthPx,
          heightPx: asset.heightPx,
          sha256: digest,
        },
      });
    res.status(201).json({ asset });
  },
);

router.delete(
  "/print/assets/:id",
  adminOnly,
  async (req, res): Promise<void> => {
    const tenantId = requestTenantId(req);
    const id = Number(req.params.id);
    const [asset] = await db
      .update(printAssetsTable)
      .set({ isActive: false })
      .where(
        and(
          eq(printAssetsTable.tenantId, tenantId),
          eq(printAssetsTable.id, id),
        ),
      )
      .returning();
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    const references = await db
      .select({ id: printTemplatesTable.id })
      .from(printTemplatesTable)
      .where(
        and(
          eq(printTemplatesTable.tenantId, tenantId),
          eq(printTemplatesTable.backgroundAssetId, id),
          eq(printTemplatesTable.isActive, true),
        ),
      )
      .limit(1);
    if (!references.length)
      await unlink(join(assetRoot, asset.storagePath)).catch(() => undefined);
    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_ASSET_DEACTIVATED",
        resourceType: "print_asset",
        resourceId: String(id),
        metadata: { retainedForTemplateReference: references.length > 0 },
      });
    res.json({ ok: true });
  },
);

// ── GET /api/print/routing ─────────────────────────────────────────────────
// Returns active operator + their printers + health status. Admin monitor page.
router.get("/print/routing", adminOnly, async (req, res): Promise<void> => {
  const tenantId = requestTenantId(req);
  const operator = await selectActiveOperator(tenantId);
  const profile = operator?.profile ?? null;

  const { primary: receiptPrinter, fallback: piFallback } =
    await resolveReceiptPrinters(profile, {
      tenantId,
      locationId: operator?.locationId,
      shiftId: operator?.shiftId,
    });
  const labelPrinter = await resolveLabelPrinter(profile, tenantId);

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
    piFallback: piFallback ? { ...piFallback, online: piOnline } : null,
    labelPrinter: labelPrinter
      ? { ...labelPrinter, online: labelOnline }
      : null,
  });
});

// ── GET /api/print/health ─────────────────────────────────────────────────
router.get("/print/health", adminOnly, async (req, res): Promise<void> => {
  const tenantId = requestTenantId(req);
  const printers = await db
    .select()
    .from(printPrintersTable)
    .where(
      and(
        eq(printPrintersTable.tenantId, tenantId),
        eq(printPrintersTable.isActive, true),
      ),
    );

  const results = await Promise.all(
    printers.map(async (p) => {
      const online = await probePrinter(p);
      return {
        id: p.id,
        name: p.name,
        role: p.role,
        connectionType: p.connectionType,
        online,
      };
    }),
  );

  res.json({ printers: results });
});

// ── GET /api/print/printers ───────────────────────────────────────────────
router.get("/print/printers", adminOnly, async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: printPrintersTable.id,
      locationId: printPrintersTable.locationId,
      routingScope: printPrintersTable.routingScope,
      name: printPrintersTable.name,
      role: printPrintersTable.role,
      connectionType: printPrintersTable.connectionType,
      bridgeProfileId: printPrintersTable.bridgeProfileId,
      bridgePrinterName: printPrintersTable.bridgePrinterName,
      isActive: printPrintersTable.isActive,
      paperWidth: printPrintersTable.paperWidth,
      copies: printPrintersTable.copies,
    })
    .from(printPrintersTable)
    .where(eq(printPrintersTable.tenantId, requestTenantId(req)))
    .orderBy(printPrintersTable.name);
  res.json({ printers: rows });
});

const VALID_ROLES = ["kitchen", "receipt", "expo", "label", "bar"];
const VALID_CONN_TYPES = [
  "ethernet_direct",
  "mac_bridge",
  "pi_bridge",
  "bridge",
];

// ── POST /api/print/printers ──────────────────────────────────────────────
router.post("/print/printers", adminOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const tenantId = requestTenantId(req);
  if (!b.name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (b.role && !VALID_ROLES.includes(b.role)) {
    res
      .status(400)
      .json({ error: `role must be one of: ${VALID_ROLES.join(", ")}` });
    return;
  }
  if (b.connectionType && !VALID_CONN_TYPES.includes(b.connectionType)) {
    res
      .status(400)
      .json({
        error: `connectionType must be one of: ${VALID_CONN_TYPES.join(", ")}`,
      });
    return;
  }
  const connType: string = b.connectionType ?? "bridge";
  const needsBridge = ["mac_bridge", "pi_bridge", "bridge"].includes(connType);
  if (needsBridge && !b.bridgeProfileId) {
    res
      .status(400)
      .json({ error: "bridgeProfileId is required for bridge printers" });
    return;
  }
  if (connType === "ethernet_direct" && !b.directIp) {
    res
      .status(400)
      .json({ error: "directIp is required for ethernet_direct printers" });
    return;
  }

  const bridgeProfile = b.bridgeProfileId
    ? (
        await db
          .select()
          .from(printBridgeProfilesTable)
          .where(
            and(
              eq(printBridgeProfilesTable.tenantId, tenantId),
              eq(printBridgeProfilesTable.id, Number(b.bridgeProfileId)),
              eq(printBridgeProfilesTable.isActive, true),
            ),
          )
          .limit(1)
      )[0]
    : null;
  if (needsBridge && !bridgeProfile) {
    res
      .status(400)
      .json({ error: "Active bridge profile not found in this tenant" });
    return;
  }
  const locationId = b.locationId ? Number(b.locationId) : null;
  const routingScope = locationId ? "location" : "general";
  if (locationId) {
    const [location] = await db
      .select()
      .from(inventoryLocationsTable)
      .where(
        and(
          eq(inventoryLocationsTable.tenantId, tenantId),
          eq(inventoryLocationsTable.id, locationId),
          eq(inventoryLocationsTable.isActive, true),
        ),
      )
      .limit(1);
    if (!location) {
      res
        .status(400)
        .json({ error: "Active location not found in this tenant" });
      return;
    }
  }
  const [printer] = await db
    .insert(printPrintersTable)
    .values({
      tenantId,
      locationId,
      routingScope,
      name: String(b.name),
      role: String(b.role ?? "kitchen"),
      connectionType: connType,
      directIp: b.directIp ? String(b.directIp) : null,
      directPort: b.directPort ? Number(b.directPort) : 9100,
      bridgeProfileId: bridgeProfile?.id ?? null,
      bridgeUrl: bridgeProfile?.bridgeUrl ?? "",
      bridgePrinterName: b.bridgePrinterName
        ? String(b.bridgePrinterName)
        : null,
      apiKey: null,
      timeoutMs: b.timeoutMs ? Number(b.timeoutMs) : 8000,
      copies: b.copies ? Math.min(5, Math.max(1, Number(b.copies))) : 1,
      paperWidth: b.paperWidth ? String(b.paperWidth) : "80mm",
      isActive: b.isActive !== undefined ? Boolean(b.isActive) : true,
    })
    .returning();
  await db
    .insert(auditLogsTable)
    .values({
      tenantId,
      actorId: req.dbUser!.id,
      actorEmail: req.dbUser!.email ?? "",
      actorRole: req.dbUser!.role,
      action: "PRINT_PRINTER_CREATED",
      resourceType: "print_printer",
      resourceId: String(printer.id),
      metadata: {
        locationId,
        routingScope,
        role: printer.role,
        bridgeProfileId: printer.bridgeProfileId,
      },
    });
  res.status(201).json({ printer });
});

// ── PATCH /api/print/printers/:id ─────────────────────────────────────────
router.patch(
  "/print/printers/:id",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const tenantId = requestTenantId(req);
    const b = req.body ?? {};
    const updates: Record<string, unknown> = {};
    if (b.name !== undefined) updates.name = String(b.name);
    if (b.role !== undefined) updates.role = String(b.role);
    if (b.connectionType !== undefined)
      updates.connectionType = String(b.connectionType);
    if (
      b.tenantId !== undefined ||
      b.locationId !== undefined ||
      b.routingScope !== undefined ||
      b.bridgeUrl !== undefined ||
      b.apiKey !== undefined
    ) {
      res
        .status(400)
        .json({
          error:
            "Ownership, scope, bridge URL, and credentials cannot be changed through this endpoint",
        });
      return;
    }
    if (b.bridgeProfileId !== undefined) {
      const [bridge] = await db
        .select()
        .from(printBridgeProfilesTable)
        .where(
          and(
            eq(printBridgeProfilesTable.tenantId, tenantId),
            eq(printBridgeProfilesTable.id, Number(b.bridgeProfileId)),
          ),
        )
        .limit(1);
      if (!bridge) {
        res
          .status(400)
          .json({ error: "Bridge profile not found in this tenant" });
        return;
      }
      updates.bridgeProfileId = bridge.id;
      updates.bridgeUrl = bridge.bridgeUrl;
    }
    if (b.directIp !== undefined)
      updates.directIp = b.directIp ? String(b.directIp) : null;
    if (b.directPort !== undefined) updates.directPort = Number(b.directPort);
    if (b.bridgePrinterName !== undefined)
      updates.bridgePrinterName = String(b.bridgePrinterName);
    if (b.timeoutMs !== undefined) updates.timeoutMs = Number(b.timeoutMs);
    if (b.copies !== undefined)
      updates.copies = Math.min(5, Math.max(1, Number(b.copies)));
    if (b.paperWidth !== undefined) updates.paperWidth = String(b.paperWidth);
    if (b.isActive !== undefined) updates.isActive = Boolean(b.isActive);
    const [row] = await db
      .update(printPrintersTable)
      .set(updates as Partial<typeof printPrintersTable.$inferInsert>)
      .where(
        and(
          eq(printPrintersTable.tenantId, tenantId),
          eq(printPrintersTable.id, id),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Printer not found" });
      return;
    }
    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_PRINTER_UPDATED",
        resourceType: "print_printer",
        resourceId: String(row.id),
        metadata: { fields: Object.keys(updates) },
      });
    res.json({ printer: row });
  },
);

// ── DELETE /api/print/printers/:id ────────────────────────────────────────
router.delete(
  "/print/printers/:id",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const tenantId = requestTenantId(req);
    await db
      .delete(printPrintersTable)
      .where(
        and(
          eq(printPrintersTable.tenantId, tenantId),
          eq(printPrintersTable.id, id),
        ),
      );
    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_PRINTER_DELETED",
        resourceType: "print_printer",
        resourceId: String(id),
        metadata: {},
      });
    res.json({ ok: true });
  },
);

// ── POST /api/print/printers/:id/test ────────────────────────────────────
// Synchronous — awaits dispatch and returns the real pass/fail result.
router.post(
  "/print/printers/:id/test",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const tenantId = requestTenantId(req);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Valid printer id is required" });
      return;
    }
    const body = req.body ?? {};
    if (Object.keys(body).some((key) => key !== "testId")) {
      res
        .status(400)
        .json({
          error:
            "Only a testId may be supplied; content and routing are server-controlled",
        });
      return;
    }
    const [printer] = await db
      .select()
      .from(printPrintersTable)
      .where(
        and(
          eq(printPrintersTable.tenantId, tenantId),
          eq(printPrintersTable.id, id),
          eq(printPrintersTable.isActive, true),
        ),
      )
      .limit(1);
    if (!printer) {
      res.status(404).json({ error: "Printer not found" });
      return;
    }
    if (printer.role !== "receipt") {
      res
        .status(400)
        .json({
          error: "UI controlled test requires an active receipt printer",
        });
      return;
    }
    if (printer.routingScope !== "general" || printer.locationId !== null) {
      res
        .status(409)
        .json({
          error:
            "Location printers must be exercised through an authoritative active shift assignment",
        });
      return;
    }
    if (!printer.bridgeProfileId) {
      res.status(409).json({ error: "Registered bridge profile is required" });
      return;
    }
    const [bridge] = await db
      .select()
      .from(printBridgeProfilesTable)
      .where(
        and(
          eq(printBridgeProfilesTable.tenantId, tenantId),
          eq(printBridgeProfilesTable.id, printer.bridgeProfileId),
          eq(printBridgeProfilesTable.isActive, true),
          eq(printBridgeProfilesTable.routingScope, "general"),
        ),
      )
      .limit(1);
    if (!bridge || bridge.locationId !== null) {
      res
        .status(409)
        .json({ error: "Active tenant-scoped general bridge not found" });
      return;
    }

    const bridgePrinterName = printer.bridgePrinterName ?? printer.name;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(bridgePrinterName)) {
      res
        .status(409)
        .json({
          error:
            "Registered explicit queue is invalid; refusing default queue fallback",
        });
      return;
    }
    const requestedTestId =
      typeof body.testId === "string" ? body.testId.trim() : "";
    const testId = /^[A-Za-z0-9_.-]{1,64}$/.test(requestedTestId)
      ? requestedTestId
      : `ui-${Date.now()}`;
    const timestamp = new Date().toISOString();
    const testText = [
      "================================",
      "      MYORDER DEV UI TEST       ",
      "     NOT A CUSTOMER ORDER       ",
      "================================",
      `Test ID : ${testId}`,
      `Time    : ${timestamp}`,
      "Role    : receipt",
      "================================",
      "",
      "",
    ].join("\n");

    // Use a unique idempotency key so repeated test presses each create a new job
    const iKey = `ui-test:${tenantId}:${printer.id}:${testId}`;
    const [job] = await db
      .insert(printJobsTable)
      .values({
        tenantId,
        locationId: null,
        shiftId: null,
        orderId: null,
        printerId: printer.id,
        jobType: "receipt",
        status: "queued",
        idempotencyKey: iKey,
        renderFormat: "text",
        payloadJson: {
          controlledUiTest: true,
          testId,
          timestamp,
          printerRole: "receipt",
        },
        renderedText: testText,
        maxRetries: 1,
      })
      .returning();
    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_UI_TEST_SUBMITTED",
        resourceType: "print_job",
        resourceId: String(job.id),
        metadata: { printerId: printer.id, bridgeProfileId: bridge.id, testId },
      });

    // Await the full dispatch so we can report the actual result
    await dispatchJob(job, printer).catch(() => {});

    // Re-fetch the job to get final status + error
    const [finalJob] = await db
      .select()
      .from(printJobsTable)
      .where(eq(printJobsTable.id, job.id))
      .limit(1);
    const ok = finalJob?.status === "printed";

    res.json({
      ok,
      jobId: job.id,
      status: finalJob?.status ?? "unknown",
      testId,
      error: ok
        ? undefined
        : (finalJob?.errorMessage ?? "Print job did not complete"),
    });
  },
);

// ── POST /api/print/printers/:id/probe ───────────────────────────────────
router.post(
  "/print/printers/:id/probe",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const tenantId = requestTenantId(req);
    const [printer] = await db
      .select()
      .from(printPrintersTable)
      .where(
        and(
          eq(printPrintersTable.tenantId, tenantId),
          eq(printPrintersTable.id, id),
        ),
      )
      .limit(1);
    if (!printer) {
      res.status(404).json({ error: "Printer not found" });
      return;
    }
    const online = await probePrinter(printer);
    res.json({ id, online });
  },
);

// ── Operator Profiles ─────────────────────────────────────────────────────
router.get("/print/profiles", adminOnly, async (req, res): Promise<void> => {
  const tenantId = requestTenantId(req);
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
      fallbackReceiptPrinterId:
        operatorPrintProfilesTable.fallbackReceiptPrinterId,
      isDefault: operatorPrintProfilesTable.isDefault,
    })
    .from(operatorPrintProfilesTable)
    .innerJoin(usersTable, eq(operatorPrintProfilesTable.userId, usersTable.id))
    .where(eq(operatorPrintProfilesTable.tenantId, tenantId))
    .orderBy(usersTable.email);
  res.json({ profiles: rows });
});

router.post("/print/profiles", adminOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const tenantId = requestTenantId(req);
  if (!b.userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  if (b.fallbackReceiptPrinterId) {
    res.status(400).json({ error: "Cross-printer fallback is prohibited" });
    return;
  }
  const [targetUser] = await db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.tenantId, tenantId),
        eq(usersTable.id, Number(b.userId)),
        eq(usersTable.isActive, true),
      ),
    )
    .limit(1);
  if (!targetUser) {
    res.status(400).json({ error: "Active user not found in this tenant" });
    return;
  }
  const printerIds = [b.receiptPrinterId, b.labelPrinterId, b.expoPrinterId]
    .filter(Boolean)
    .map(Number);
  if (printerIds.length) {
    const printers = await db
      .select()
      .from(printPrintersTable)
      .where(
        and(
          eq(printPrintersTable.tenantId, tenantId),
          inArray(printPrintersTable.id, printerIds),
          eq(printPrintersTable.isActive, true),
        ),
      );
    if (printers.length !== new Set(printerIds).size) {
      res
        .status(400)
        .json({
          error:
            "Every selected printer must be active and owned by this tenant",
        });
      return;
    }
  }
  const existing = await db
    .select()
    .from(operatorPrintProfilesTable)
    .where(
      and(
        eq(operatorPrintProfilesTable.tenantId, tenantId),
        eq(operatorPrintProfilesTable.userId, Number(b.userId)),
        sql`${operatorPrintProfilesTable.locationId} IS NULL`,
        sql`${operatorPrintProfilesTable.shiftId} IS NULL`,
      ),
    )
    .limit(1);
  if (existing.length) {
    const [updated] = await db
      .update(operatorPrintProfilesTable)
      .set({
        receiptPrinterId: b.receiptPrinterId
          ? Number(b.receiptPrinterId)
          : null,
        labelPrinterId: b.labelPrinterId ? Number(b.labelPrinterId) : null,
        fallbackReceiptPrinterId: null,
        expoPrinterId: b.expoPrinterId ? Number(b.expoPrinterId) : null,
        printExpoTickets: Boolean(b.printExpoTickets),
        isDefault: Boolean(b.isDefault),
      })
      .where(
        and(
          eq(operatorPrintProfilesTable.tenantId, tenantId),
          eq(operatorPrintProfilesTable.id, existing[0].id),
        ),
      )
      .returning();
    res.json({ profile: updated });
    return;
  }
  const [profile] = await db
    .insert(operatorPrintProfilesTable)
    .values({
      tenantId,
      userId: Number(b.userId),
      receiptPrinterId: b.receiptPrinterId ? Number(b.receiptPrinterId) : null,
      labelPrinterId: b.labelPrinterId ? Number(b.labelPrinterId) : null,
      fallbackReceiptPrinterId: null,
      expoPrinterId: b.expoPrinterId ? Number(b.expoPrinterId) : null,
      printExpoTickets: Boolean(b.printExpoTickets),
      isDefault: Boolean(b.isDefault),
    })
    .returning();
  res.status(201).json({ profile });
});

router.delete(
  "/print/profiles/:id",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    await db
      .delete(operatorPrintProfilesTable)
      .where(
        and(
          eq(operatorPrintProfilesTable.tenantId, requestTenantId(req)),
          eq(operatorPrintProfilesTable.id, id),
        ),
      );
    res.json({ ok: true });
  },
);

// ── Templates ─────────────────────────────────────────────────────────────
router.get("/print/templates", adminOnly, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(printTemplatesTable)
    .where(eq(printTemplatesTable.tenantId, requestTenantId(req)))
    .orderBy(printTemplatesTable.name);
  res.json({ templates: rows });
});

router.post("/print/templates", adminOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const tenantId = requestTenantId(req);
  if (!b.name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const parsed = receiptTemplateLayoutSchema.safeParse(b.templateJson ?? []);
  if (!parsed.success) {
    res
      .status(400)
      .json({
        error: "Invalid declarative template layout",
        details: parsed.error.issues,
      });
    return;
  }
  const parsedLayout = parsed.data;
  if (b.backgroundAssetId) {
    const [asset] = await db
      .select()
      .from(printAssetsTable)
      .where(
        and(
          eq(printAssetsTable.tenantId, tenantId),
          eq(printAssetsTable.id, Number(b.backgroundAssetId)),
          eq(printAssetsTable.isActive, true),
        ),
      )
      .limit(1);
    if (!asset) {
      res
        .status(400)
        .json({ error: "Active template asset not found in this tenant" });
      return;
    }
  }
  const [t] = await db
    .insert(printTemplatesTable)
    .values({
      tenantId,
      name: String(b.name),
      jobType: String(b.jobType ?? "label"),
      backgroundAssetId: b.backgroundAssetId
        ? Number(b.backgroundAssetId)
        : null,
      templateJson: parsedLayout,
      createdByUserId: req.dbUser!.id,
      paperWidth: String(b.paperWidth ?? "58mm"),
      paperHeight: String(b.paperHeight ?? "auto"),
      isActive: b.isActive !== undefined ? Boolean(b.isActive) : true,
      isDefault: Boolean(b.isDefault),
    })
    .returning();
  await db
    .insert(printTemplateVersionsTable)
    .values({
      tenantId,
      templateId: t.id,
      version: 1,
      schemaVersion: 1,
      templateJson: parsedLayout,
      backgroundAssetId: t.backgroundAssetId,
      paperWidth: t.paperWidth,
      paperHeight: t.paperHeight,
      createdByUserId: req.dbUser!.id,
    });
  await db
    .insert(auditLogsTable)
    .values({
      tenantId,
      actorId: req.dbUser!.id,
      actorEmail: req.dbUser!.email ?? "",
      actorRole: req.dbUser!.role,
      action: "PRINT_TEMPLATE_CREATED",
      resourceType: "print_template",
      resourceId: String(t.id),
      metadata: { version: 1, jobType: t.jobType },
    });
  res.status(201).json({ template: t });
});

router.patch(
  "/print/templates/:id",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const tenantId = requestTenantId(req);
    const b = req.body ?? {};
    const [existing] = await db
      .select()
      .from(printTemplatesTable)
      .where(
        and(
          eq(printTemplatesTable.tenantId, tenantId),
          eq(printTemplatesTable.id, id),
        ),
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    const updates: Record<string, unknown> = {};
    if (b.name !== undefined) updates.name = String(b.name);
    if (b.jobType !== undefined) updates.jobType = String(b.jobType);
    if (b.backgroundAssetId !== undefined) {
      if (b.backgroundAssetId) {
        const [asset] = await db
          .select()
          .from(printAssetsTable)
          .where(
            and(
              eq(printAssetsTable.tenantId, tenantId),
              eq(printAssetsTable.id, Number(b.backgroundAssetId)),
              eq(printAssetsTable.isActive, true),
            ),
          )
          .limit(1);
        if (!asset) {
          res
            .status(400)
            .json({ error: "Active template asset not found in this tenant" });
          return;
        }
      }
      updates.backgroundAssetId = b.backgroundAssetId
        ? Number(b.backgroundAssetId)
        : null;
    }
    if (b.templateJson !== undefined) {
      const parsed = receiptTemplateLayoutSchema.safeParse(b.templateJson);
      if (!parsed.success) {
        res
          .status(400)
          .json({
            error: "Invalid declarative template layout",
            details: parsed.error.issues,
          });
        return;
      }
      updates.templateJson = parsed.data;
    }
    if (b.paperWidth !== undefined) updates.paperWidth = String(b.paperWidth);
    if (b.paperHeight !== undefined)
      updates.paperHeight = String(b.paperHeight);
    if (b.isActive !== undefined) updates.isActive = Boolean(b.isActive);
    if (b.isDefault !== undefined) updates.isDefault = Boolean(b.isDefault);
    updates.version = existing.version + 1;
    const [t] = await db
      .update(printTemplatesTable)
      .set(updates as Partial<typeof printTemplatesTable.$inferInsert>)
      .where(
        and(
          eq(printTemplatesTable.tenantId, tenantId),
          eq(printTemplatesTable.id, id),
        ),
      )
      .returning();
    if (!t) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    await db
      .insert(printTemplateVersionsTable)
      .values({
        tenantId,
        templateId: t.id,
        version: t.version,
        schemaVersion: t.schemaVersion,
        templateJson: t.templateJson,
        backgroundAssetId: t.backgroundAssetId,
        paperWidth: t.paperWidth,
        paperHeight: t.paperHeight,
        createdByUserId: req.dbUser!.id,
      });
    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_TEMPLATE_UPDATED",
        resourceType: "print_template",
        resourceId: String(t.id),
        metadata: { version: t.version, fields: Object.keys(updates) },
      });
    res.json({ template: t });
  },
);

router.delete(
  "/print/templates/:id",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const tenantId = requestTenantId(req);
    await db
      .update(printTemplatesTable)
      .set({ isActive: false })
      .where(
        and(
          eq(printTemplatesTable.tenantId, tenantId),
          eq(printTemplatesTable.id, id),
        ),
      );
    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_TEMPLATE_DEACTIVATED",
        resourceType: "print_template",
        resourceId: String(id),
        metadata: {},
      });
    res.json({ ok: true });
  },
);

// ── Jobs ──────────────────────────────────────────────────────────────────
router.get("/print/jobs", adminOnly, async (req, res): Promise<void> => {
  const tenantId = requestTenantId(req);
  const status = req.query.status as string | undefined;
  let q = db
    .select()
    .from(printJobsTable)
    .orderBy(desc(printJobsTable.createdAt))
    .limit(200)
    .$dynamic();
  q = q.where(
    status && status !== "all"
      ? and(
          eq(printJobsTable.tenantId, tenantId),
          inArray(printJobsTable.status, status.split(",")),
        )
      : eq(printJobsTable.tenantId, tenantId),
  );
  const jobs = await q;
  res.json({ jobs });
});

router.get("/print/jobs/:id", adminOnly, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const tenantId = requestTenantId(req);
  const [job] = await db
    .select()
    .from(printJobsTable)
    .where(
      and(eq(printJobsTable.tenantId, tenantId), eq(printJobsTable.id, id)),
    )
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const attempts = await db
    .select()
    .from(printJobAttemptsTable)
    .where(
      and(
        eq(printJobAttemptsTable.tenantId, tenantId),
        eq(printJobAttemptsTable.printJobId, id),
      ),
    )
    .orderBy(printJobAttemptsTable.attemptNumber);
  res.json({ job, attempts });
});

router.post(
  "/print/jobs/:id/retry",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const tenantId = requestTenantId(req);
    const [job] = await db
      .select()
      .from(printJobsTable)
      .where(
        and(eq(printJobsTable.tenantId, tenantId), eq(printJobsTable.id, id)),
      )
      .limit(1);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (!job.printerId) {
      res.status(400).json({ error: "Job has no printer" });
      return;
    }

    const [printer] = await db
      .select()
      .from(printPrintersTable)
      .where(
        and(
          eq(printPrintersTable.tenantId, tenantId),
          eq(printPrintersTable.id, job.printerId),
        ),
      )
      .limit(1);
    if (!printer) {
      res.status(404).json({ error: "Printer not found" });
      return;
    }

    await db
      .update(printJobsTable)
      .set({ status: "queued", retryCount: 0, errorMessage: null })
      .where(
        and(eq(printJobsTable.tenantId, tenantId), eq(printJobsTable.id, id)),
      );

    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_JOB_REPRINT_REQUESTED",
        resourceType: "print_job",
        resourceId: String(id),
        metadata: { printerId: printer.id, originalOrderId: job.orderId },
      });

    const fresh = {
      ...job,
      status: "queued",
      retryCount: 0,
      errorMessage: null,
    };
    dispatchJob(fresh, printer).catch(() => {});
    res.json({ ok: true });
  },
);

router.post(
  "/print/jobs/:id/reprint",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const tenantId = requestTenantId(req);
    const [job] = await db
      .select()
      .from(printJobsTable)
      .where(
        and(eq(printJobsTable.tenantId, tenantId), eq(printJobsTable.id, id)),
      )
      .limit(1);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (!job.printerId) {
      res
        .status(400)
        .json({ error: "Cannot reprint: no printer assigned to this job" });
      return;
    }

    const [printer] = await db
      .select()
      .from(printPrintersTable)
      .where(
        and(
          eq(printPrintersTable.tenantId, tenantId),
          eq(printPrintersTable.id, job.printerId),
          eq(printPrintersTable.isActive, true),
        ),
      )
      .limit(1);
    if (!printer) {
      res.status(404).json({ error: "Printer not found" });
      return;
    }

    // Use orderId if present; test jobs have orderId=null so fall back to job id
    const keyOrderId = job.orderId ?? job.id * -1;
    const newKey = makeIdempotencyKey(
      keyOrderId,
      job.printerId,
      `${job.jobType}:reprint:${Date.now()}`,
    );
    const [newJob] = await db
      .insert(printJobsTable)
      .values({
        tenantId,
        locationId: job.locationId,
        shiftId: job.shiftId,
        orderId: job.orderId,
        printerId: job.printerId,
        jobType: job.jobType,
        status: "queued",
        idempotencyKey: newKey,
        renderFormat: job.renderFormat,
        payloadJson: job.payloadJson as object,
        renderedText: job.renderedText,
        operatorUserId: job.operatorUserId ?? null,
      })
      .returning();
    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_JOB_REPRINT_CREATED",
        resourceType: "print_job",
        resourceId: String(newJob.id),
        metadata: {
          originalJobId: job.id,
          orderId: job.orderId,
          printerId: printer.id,
        },
      });

    dispatchJob(newJob, printer).catch(() => {});
    res.json({ ok: true, jobId: newJob.id });
  },
);

// ── Settings ──────────────────────────────────────────────────────────────
router.get("/print/settings", adminOnly, async (_req, res): Promise<void> => {
  const settings = await getSettings();
  res.json({ settings });
});

router.patch("/print/settings", adminOnly, async (req, res): Promise<void> => {
  const b = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (b.autoPrintOrders !== undefined)
    updates.autoPrintOrders = Boolean(b.autoPrintOrders);
  if (b.autoPrintReceipts !== undefined)
    updates.autoPrintReceipts = Boolean(b.autoPrintReceipts);
  if (b.autoPrintLabels !== undefined)
    updates.autoPrintLabels = Boolean(b.autoPrintLabels);
  if (b.retryBackoffBaseMs !== undefined)
    updates.retryBackoffBaseMs = Number(b.retryBackoffBaseMs);
  if (b.staleJobMinutes !== undefined)
    updates.staleJobMinutes = Number(b.staleJobMinutes);
  if (b.alertOnLabelFailure !== undefined)
    updates.alertOnLabelFailure = Boolean(b.alertOnLabelFailure);
  if (b.includeLogo !== undefined) updates.includeLogo = Boolean(b.includeLogo);
  if (b.includeOperatorName !== undefined)
    updates.includeOperatorName = Boolean(b.includeOperatorName);
  if (b.showDiscreetNotice !== undefined)
    updates.showDiscreetNotice = Boolean(b.showDiscreetNotice);
  if (b.paperWidth !== undefined) updates.paperWidth = String(b.paperWidth);
  if (b.brandName !== undefined)
    updates.brandName = b.brandName ? String(b.brandName) : null;
  if (b.footerMessage !== undefined)
    updates.footerMessage = b.footerMessage ? String(b.footerMessage) : null;
  if (b.receiptTemplateStyle !== undefined)
    updates.receiptTemplateStyle = String(b.receiptTemplateStyle || "clean");
  if (b.labelTemplateStyle !== undefined)
    updates.labelTemplateStyle = String(
      b.labelTemplateStyle || "thank_you_personalized",
    );
  const settings = await getSettings();
  const [updated] = await db
    .update(printSettingsTable)
    .set(updates as Partial<typeof printSettingsTable.$inferInsert>)
    .where(eq(printSettingsTable.id, settings.id))
    .returning();
  res.json({ settings: updated });
});

// ── Print Previews ─────────────────────────────────────────────────────────
// Returns rendered plain-text for browser preview and test-dispatch review.

router.post(
  "/print/preview/receipt",
  adminOnly,
  async (req, res): Promise<void> => {
    const settings = await getSettings();
    const s = settings as Record<string, unknown>;
    const width = charWidth((s.paperWidth as string) ?? "80mm");
    const dualBrandName = s.brandName as string | undefined;
    const logoLines = s.includeLogo !== false ? getLogo(width) : [];
    const receiptTemplateStyle =
      (s.receiptTemplateStyle as "clean" | "classic" | "compact" | undefined) ??
      "clean";
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
        {
          name: "Blue Dream 3.5g",
          quantity: 1,
          unitPrice: 45.0,
          totalPrice: 45.0,
        },
        {
          name: "House Special",
          quantity: 2,
          unitPrice: 30.0,
          totalPrice: 60.0,
          notes: "Extra discreet packaging",
        },
      ],
      subtotal: body.subtotal ?? 105.0,
      tax: body.tax ?? 0,
      total: body.total ?? 105.0,
      logoLines,
      dualBrandName,
      footerMessage: s.footerMessage as string | undefined,
      showDiscreetNotice: Boolean(s.showDiscreetNotice),
      showOperatorName: s.includeOperatorName !== false,
      receiptTemplateStyle,
    });
    res.type("text/plain").send(renderBlocks(blocks, width));
  },
);

router.post(
  "/print/preview/inventory-start",
  adminOnly,
  async (req, res): Promise<void> => {
    const settings = await getSettings();
    const s = settings as Record<string, unknown>;
    const width = charWidth((s.paperWidth as string) ?? "80mm");
    const logoLines = s.includeLogo !== false ? getLogo(width) : [];
    const body = req.body ?? {};
    const blocks = buildInventoryStartBlocks({
      shiftId: body.shiftId ?? "PREVIEW",
      operatorName: body.operatorName ?? "Preview Operator",
      clockedInAt: body.clockedInAt ?? new Date(),
      tenantName: body.tenantName,
      items: body.items ?? [
        {
          rowType: "section",
          sectionName: "Sample Section",
          itemName: "Sample Section",
          unitType: "#",
          quantityStart: 0,
        },
        {
          rowType: "item",
          itemName: "Sample Item",
          unitType: "#",
          quantityStart: 10,
        },
      ],
      logoLines,
      footerMessage: s.footerMessage as string | undefined,
    });
    res.type("text/plain").send(renderBlocks(blocks, width));
  },
);

router.post(
  "/print/preview/inventory-end",
  adminOnly,
  async (req, res): Promise<void> => {
    const settings = await getSettings();
    const s = settings as Record<string, unknown>;
    const width = charWidth((s.paperWidth as string) ?? "80mm");
    const logoLines = s.includeLogo !== false ? getLogo(width) : [];
    const body = req.body ?? {};
    const blocks = buildInventoryEndBlocks({
      shiftId: body.shiftId ?? "PREVIEW",
      operatorName: body.operatorName ?? "Preview Operator",
      clockedInAt: body.clockedInAt ?? new Date(Date.now() - 3600000),
      clockedOutAt: body.clockedOutAt ?? new Date(),
      tenantName: body.tenantName,
      items: body.items ?? [
        {
          rowType: "section",
          sectionName: "Sample Section",
          itemName: "Sample Section",
          unitType: "#",
          quantityStart: 0,
          quantitySold: 0,
          quantityEnd: 0,
        },
        {
          rowType: "item",
          itemName: "Sample Item",
          unitType: "#",
          quantityStart: 10,
          quantitySold: 3,
          quantityEnd: 7,
        },
      ],
      totalSales: body.totalSales,
      pettyCash: body.pettyCash,
      notes: body.notes,
      logoLines,
      footerMessage: (settings as Record<string, unknown>).footerMessage as
        | string
        | undefined,
    });
    res.type("text/plain").send(renderBlocks(blocks, width));
  },
);

router.post(
  "/print/preview/label",
  adminOnly,
  async (req, res): Promise<void> => {
    const settings = await getSettings();
    const width = charWidth(
      ((settings as Record<string, unknown>).paperWidth as string) ?? "80mm",
    );
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
  },
);

// ── Thank You Label (PNG image) ────────────────────────────────────────────
// GET  /api/print/preview/thank-you-label?name=<firstName>
//   Returns a PNG image of the personalized sticker for browser preview.
// POST /api/print/label/thank-you
//   Body: { firstName, copies? }
//   Generates label, dispatches to the label printer, returns job info.

router.get(
  "/print/preview/thank-you-label",
  adminOnly,
  async (req, res): Promise<void> => {
    const { generateThankYouLabel, resolveLabelFirstName } =
      await import("../lib/print/templates/thankYouLabel.js");
    const firstName = resolveLabelFirstName({
      canonicalFirstName: String(req.query.name ?? ""),
    });
    try {
      const buf = await generateThankYouLabel(firstName);
      res.type("image/png").send(buf);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  },
);

router.post(
  "/print/label/thank-you",
  adminOnly,
  async (req, res): Promise<void> => {
    const tenantId = requestTenantId(req);
    const { generateThankYouLabel, resolveLabelFirstName } =
      await import("../lib/print/templates/thankYouLabel.js");
    const b = req.body ?? {};
    const firstName = resolveLabelFirstName({
      canonicalFirstName: String(b.firstName ?? ""),
    });
    const copies = Math.min(
      5,
      Math.max(1, parseInt(String(b.copies ?? 1), 10)),
    );

    // Resolve label printer
    const operator = await selectActiveOperator(tenantId);
    const labelPrinter = await resolveLabelPrinter(
      operator?.profile ?? null,
      tenantId,
    );
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
    const [job] = await db
      .insert(printJobsTable)
      .values({
        tenantId,
        locationId: operator?.locationId ?? null,
        shiftId: operator?.shiftId ?? null,
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
      })
      .returning();

    // Dispatch and await result
    await dispatchJob(job, labelPrinter).catch(() => {});

    const [finalJob] = await db
      .select()
      .from(printJobsTable)
      .where(eq(printJobsTable.id, job.id))
      .limit(1);

    if (copies > 1) {
      // Additional copies: fire-and-forget
      for (let i = 1; i < copies; i++) {
        const extraKey = `thank-you-label:${firstName}:${Date.now()}:copy${i}`;
        const [extraJob] = await db
          .insert(printJobsTable)
          .values({
            tenantId,
            locationId: operator?.locationId ?? null,
            shiftId: operator?.shiftId ?? null,
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
          })
          .returning();
        dispatchJob(extraJob, labelPrinter).catch(() => {});
      }
    }

    res.json({
      ok: finalJob?.status === "printed",
      jobId: job.id,
      status: finalJob?.status ?? "unknown",
      firstName,
      printerName: labelPrinter.name,
      error:
        finalJob?.status === "printed"
          ? undefined
          : (finalJob?.errorMessage ?? "Job did not complete"),
    });
  },
);

// ── Per-order print triggers (any approved user) ──────────────────────────
// Called from the staff CSR queue when a rep manually hits "Print Receipt"
// or "Print Label". Does NOT require adminOnly — business_sitter / CSR role
// is enough (router-level middleware already requires auth + approved).

/** POST /api/print/orders/:id/receipt — reprint/trigger receipt for an order */
router.post("/print/orders/:id/receipt", async (req, res): Promise<void> => {
  const tenantId = requestTenantId(req);
  const orderId = parseInt(String(req.params.id), 10);
  if (isNaN(orderId)) {
    res.status(400).json({ error: "Invalid order id" });
    return;
  }

  const [order] = await db
    .select()
    .from(ordersTable)
    .where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.id, orderId)))
    .limit(1);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  const items = await db
    .select()
    .from(orderItemsTable)
    .where(eq(orderItemsTable.orderId, orderId));

  const [customer] = await db
    .select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable)
    .where(eq(usersTable.id, order.customerId))
    .limit(1);
  const customerName = customer
    ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim()
    : "";

  const operator = await selectActiveOperator(tenantId);
  const [assignment] = order.assignedShiftId
    ? await db
        .select()
        .from(shiftPrintAssignmentsTable)
        .where(
          and(
            eq(shiftPrintAssignmentsTable.tenantId, tenantId),
            eq(shiftPrintAssignmentsTable.shiftId, order.assignedShiftId),
          ),
        )
        .limit(1)
    : [];
  const routeContext = {
    tenantId,
    locationId: assignment?.locationId ?? null,
    shiftId: order.assignedShiftId ?? null,
  };
  const { primary: receiptPrinter } = await resolveReceiptPrinters(
    operator?.profile ?? null,
    routeContext,
  );
  if (!receiptPrinter) {
    res
      .status(503)
      .json({ error: "No receipt printer configured or available" });
    return;
  }

  let receiptLineNameMode: "alavont_only" | "lucifer_only" | "both" =
    "lucifer_only";
  try {
    const [adminSettings] = await db
      .select({ receiptLineNameMode: adminSettingsTable.receiptLineNameMode })
      .from(adminSettingsTable)
      .where(eq(adminSettingsTable.tenantId, tenantId))
      .limit(1);
    if (adminSettings?.receiptLineNameMode) {
      receiptLineNameMode =
        adminSettings.receiptLineNameMode as typeof receiptLineNameMode;
    }
  } catch {
    /* non-critical */
  }

  const settings = await getSettings();
  const s = settings as Record<string, unknown>;
  const width = charWidth((s.paperWidth as string) ?? "80mm");
  const logoLines = s.includeLogo !== false ? getLogo(width) : [];
  const operatorName = operator
    ? `${operator.firstName ?? ""} ${operator.lastName ?? ""}`.trim() ||
      operator.email ||
      undefined
    : undefined;

  const printOrder = {
    id: order.id,
    customerName,
    notes: order.notes ?? undefined,
    receiptLineNameMode,
    items: items.map((i) => ({
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
    receiptTemplateStyle:
      (s.receiptTemplateStyle as "clean" | "classic" | "compact" | undefined) ??
      "clean",
  };

  const { renderCustomerReceipt } = await import("../lib/receiptRenderer.js");
  const renderedText = renderCustomerReceipt(printOrder);

  // Always create a fresh job for reprints (unique key per timestamp)
  const iKey = makeIdempotencyKey(
    orderId,
    receiptPrinter.id,
    `receipt:reprint:${Date.now()}`,
  );
  const [job] = await db
    .insert(printJobsTable)
    .values({
      tenantId,
      locationId: routeContext.locationId,
      shiftId: routeContext.shiftId,
      orderId,
      printerId: receiptPrinter.id,
      jobType: "receipt",
      status: "queued",
      idempotencyKey: iKey,
      renderFormat: "text",
      payloadJson: printOrder as object,
      renderedText,
      operatorUserId: operator?.userId ?? null,
    })
    .returning();
  await db
    .insert(auditLogsTable)
    .values({
      tenantId,
      actorId: req.dbUser!.id,
      actorEmail: req.dbUser!.email ?? "",
      actorRole: req.dbUser!.role,
      action: "ORDER_RECEIPT_REPRINTED",
      resourceType: "print_job",
      resourceId: String(job.id),
      metadata: { orderId, printerId: receiptPrinter.id },
    });

  await dispatchReceiptJob(job, receiptPrinter).catch(() => {});

  const [finalJob] = await db
    .select()
    .from(printJobsTable)
    .where(
      and(eq(printJobsTable.tenantId, tenantId), eq(printJobsTable.id, job.id)),
    )
    .limit(1);
  const ok = finalJob?.status === "printed";

  res.json({
    ok,
    jobId: job.id,
    status: finalJob?.status ?? "unknown",
    printerName: receiptPrinter.name,
    error: ok
      ? undefined
      : (finalJob?.errorMessage ?? "Receipt print did not complete"),
  });
});

/** POST /api/print/orders/:id/label — print delivery label with customer name */
router.post("/print/orders/:id/label", async (req, res): Promise<void> => {
  const tenantId = requestTenantId(req);
  const orderId = parseInt(String(req.params.id), 10);
  if (isNaN(orderId)) {
    res.status(400).json({ error: "Invalid order id" });
    return;
  }

  const [order] = await db
    .select()
    .from(ordersTable)
    .where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.id, orderId)))
    .limit(1);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  const [customer] = await db
    .select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable)
    .where(eq(usersTable.id, order.customerId))
    .limit(1);
  const customerName = customer
    ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim()
    : "Customer";
  const { generateThankYouLabel, resolveLabelFirstName } =
    await import("../lib/print/templates/thankYouLabel.js");
  const firstName = resolveLabelFirstName({
    canonicalFirstName: customer?.firstName,
    validatedFullName: customerName,
  });

  const operator = await selectActiveOperator(tenantId);
  const labelPrinter = await resolveLabelPrinter(
    operator?.profile ?? null,
    tenantId,
  );
  if (!labelPrinter) {
    res.status(503).json({ error: "No label printer configured" });
    return;
  }

  const png = await generateThankYouLabel(firstName);
  const renderedText = `Thank you label for ${firstName} — Order #${orderId}`;

  const iKey = makeIdempotencyKey(
    orderId,
    labelPrinter.id,
    `label:reprint:${Date.now()}`,
  );
  const [job] = await db
    .insert(printJobsTable)
    .values({
      tenantId,
      locationId: operator?.locationId ?? null,
      shiftId: operator?.shiftId ?? null,
      orderId,
      printerId: labelPrinter.id,
      jobType: "label",
      status: "queued",
      idempotencyKey: iKey,
      renderFormat: "png",
      payloadJson: {
        orderId,
        customerName,
        firstName,
        shippingAddress: order.shippingAddress ?? null,
        labelType: "thank-you",
        template: "thank_you_personalized",
        imageData: png.toString("base64"),
      },
      renderedText,
      operatorUserId: operator?.userId ?? null,
    })
    .returning();
  await db
    .insert(auditLogsTable)
    .values({
      tenantId,
      actorId: req.dbUser!.id,
      actorEmail: req.dbUser!.email ?? "",
      actorRole: req.dbUser!.role,
      action: "ORDER_LABEL_REPRINTED",
      resourceType: "print_job",
      resourceId: String(job.id),
      metadata: { orderId, printerId: labelPrinter.id },
    });

  await dispatchLabelJob(job, labelPrinter).catch(() => {});

  const [finalJob] = await db
    .select()
    .from(printJobsTable)
    .where(eq(printJobsTable.id, job.id))
    .limit(1);
  const ok = finalJob?.status === "printed";

  res.json({
    ok,
    jobId: job.id,
    status: finalJob?.status ?? "unknown",
    printerName: labelPrinter.name,
    customerName,
    error: ok
      ? undefined
      : (finalJob?.errorMessage ?? "Label print did not complete"),
  });
});

// ── Bridge Diagnostics ────────────────────────────────────────────────────
// These routes let the admin UI directly test bridge connectivity and get
// the bridge's own printer list — without going through a print job.

/** GET /api/print/bridge/health?printerId=<id>  — or defaults to first active bridge printer */
router.get(
  "/print/bridge/health",
  adminOnly,
  async (req, res): Promise<void> => {
    const pid = req.query.printerId
      ? parseInt(String(req.query.printerId), 10)
      : null;
    const tenantId = requestTenantId(req);
    if (!pid) {
      res
        .status(400)
        .json({ error: "An explicitly registered printerId is required" });
      return;
    }
    const printerRows = pid
      ? await db
          .select()
          .from(printPrintersTable)
          .where(
            and(
              eq(printPrintersTable.tenantId, tenantId),
              eq(printPrintersTable.id, pid),
              eq(printPrintersTable.isActive, true),
            ),
          )
          .limit(1)
      : [];
    const printer: typeof printPrintersTable.$inferSelect | null =
      printerRows[0] ?? null;

    if (!printer) {
      res.status(404).json({ error: "No printer found" });
      return;
    }

    const apiKey = printer.apiKey ?? process.env.PRINT_BRIDGE_API_KEY ?? "";
    const bridgeUrl = printer.bridgeUrl;
    const TIMEOUT_MS = 5000;

    if (!bridgeUrl) {
      res.json({ ok: false, error: "Bridge URL not set on this printer" });
      return;
    }
    if (!apiKey) {
      res.json({ ok: false, error: "API key not set on this printer" });
      return;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const r = await fetch(`${bridgeUrl}/health`, {
        headers: { "x-api-key": apiKey },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      let body: unknown;
      try {
        body = await r.json();
      } catch {
        body = null;
      }

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
      const isTimeout =
        msg.includes("AbortError") ||
        (err instanceof Error && err.name === "AbortError");
      res.json({
        ok: false,
        bridgeUrl,
        hasApiKey: Boolean(apiKey),
        error: isTimeout
          ? `Timed out after ${TIMEOUT_MS}ms — bridge unreachable (check Tailscale connection)`
          : `Connection failed: ${msg}`,
      });
    }
  },
);

/** GET /api/print/bridge/printers?printerId=<id>  — list bridge's known printer queues */
router.get(
  "/print/bridge/printers",
  adminOnly,
  async (req, res): Promise<void> => {
    res
      .status(410)
      .json({
        error:
          "Unrestricted bridge queue discovery is disabled; register an explicit approved queue",
      });
    return;
    const pid = req.query.printerId
      ? parseInt(String(req.query.printerId), 10)
      : null;
    const printerRows =
      pid != null
        ? await db
            .select()
            .from(printPrintersTable)
            .where(eq(printPrintersTable.id, Number(pid)))
            .limit(1)
        : await db
            .select()
            .from(printPrintersTable)
            .where(eq(printPrintersTable.isActive, true))
            .limit(1);
    const printer = printerRows[0];

    if (!printer) {
      res.status(404).json({ error: "No printer found" });
      return;
    }

    const apiKey = printer.apiKey ?? process.env.PRINT_BRIDGE_API_KEY ?? "";
    const bridgeUrl = printer.bridgeUrl;
    const TIMEOUT_MS = 5000;

    if (!bridgeUrl) {
      res.json({ ok: false, error: "Bridge URL not set on this printer" });
      return;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const r = await fetch(`${bridgeUrl}/printers`, {
        headers: apiKey ? { "x-api-key": apiKey } : {},
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      let body: unknown;
      try {
        body = await r.json();
      } catch {
        body = null;
      }
      res.json({ ok: r.ok, httpStatus: r.status, bridgeUrl, body });
    } catch (err) {
      const msg = String(err);
      const isTimeout = String(err).includes("AbortError");
      res.json({
        ok: false,
        bridgeUrl,
        error: isTimeout
          ? `Timed out after ${TIMEOUT_MS}ms — bridge unreachable`
          : `Connection failed: ${msg}`,
      });
    }
  },
);

// ── Bridge Profiles CRUD ──────────────────────────────────────────────────────

/** GET /api/print/bridge-profiles — list all bridge profiles */
router.get(
  "/print/bridge-profiles",
  adminOnly,
  async (req, res): Promise<void> => {
    const profiles = await db
      .select({
        id: printBridgeProfilesTable.id,
        locationId: printBridgeProfilesTable.locationId,
        routingScope: printBridgeProfilesTable.routingScope,
        name: printBridgeProfilesTable.name,
        bridgeType: printBridgeProfilesTable.bridgeType,
        isActive: printBridgeProfilesTable.isActive,
        priority: printBridgeProfilesTable.priority,
        supportedRoles: printBridgeProfilesTable.supportedRoles,
      })
      .from(printBridgeProfilesTable)
      .where(eq(printBridgeProfilesTable.tenantId, requestTenantId(req)))
      .orderBy(printBridgeProfilesTable.priority);
    res.json(profiles);
  },
);

/** POST /api/print/bridge-profiles — create a bridge profile */
router.post(
  "/print/bridge-profiles",
  adminOnly,
  async (req, res): Promise<void> => {
    const b = req.body ?? {};
    const tenantId = requestTenantId(req);
    if (!b.name || !b.bridgeUrl) {
      res.status(400).json({ error: "name and bridgeUrl are required" });
      return;
    }
    const locationId = b.locationId ? Number(b.locationId) : null;
    if (locationId) {
      const [location] = await db
        .select()
        .from(inventoryLocationsTable)
        .where(
          and(
            eq(inventoryLocationsTable.tenantId, tenantId),
            eq(inventoryLocationsTable.id, locationId),
            eq(inventoryLocationsTable.isActive, true),
          ),
        )
        .limit(1);
      if (!location) {
        res
          .status(400)
          .json({ error: "Active location not found in this tenant" });
        return;
      }
    }
    const [row] = await db
      .insert(printBridgeProfilesTable)
      .values({
        tenantId,
        locationId,
        routingScope: locationId ? "location" : "general",
        name: String(b.name),
        bridgeType: String(b.bridgeType ?? "generic"),
        bridgeUrl: String(b.bridgeUrl),
        apiKey: String(b.apiKey ?? ""),
        isActive: b.isActive !== false,
        priority: Number(b.priority ?? 10),
        networkSubnetHint: b.networkSubnetHint
          ? String(b.networkSubnetHint)
          : null,
        supportedRoles: String(b.supportedRoles ?? "both"),
        notes: b.notes ? String(b.notes) : null,
      })
      .returning();
    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_BRIDGE_CREATED",
        resourceType: "print_bridge",
        resourceId: String(row.id),
        metadata: {
          locationId,
          routingScope: row.routingScope,
          bridgeType: row.bridgeType,
        },
      });
    res.status(201).json(row);
  },
);

/** PATCH /api/print/bridge-profiles/:id — update a bridge profile */
router.patch(
  "/print/bridge-profiles/:id",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const tenantId = requestTenantId(req);
    const b = req.body ?? {};
    const updates: Partial<typeof printBridgeProfilesTable.$inferInsert> = {};
    if (b.name !== undefined) updates.name = String(b.name);
    if (b.bridgeType !== undefined) updates.bridgeType = String(b.bridgeType);
    if (b.bridgeUrl !== undefined) updates.bridgeUrl = String(b.bridgeUrl);
    if (b.apiKey !== undefined) updates.apiKey = String(b.apiKey);
    if (b.isActive !== undefined) updates.isActive = Boolean(b.isActive);
    if (b.priority !== undefined) updates.priority = Number(b.priority);
    if (b.networkSubnetHint !== undefined)
      updates.networkSubnetHint = b.networkSubnetHint
        ? String(b.networkSubnetHint)
        : null;
    if (b.supportedRoles !== undefined)
      updates.supportedRoles = String(b.supportedRoles);
    if (b.notes !== undefined) updates.notes = b.notes ? String(b.notes) : null;
    if (
      b.tenantId !== undefined ||
      b.locationId !== undefined ||
      b.routingScope !== undefined
    ) {
      res
        .status(400)
        .json({ error: "Bridge ownership and routing scope are immutable" });
      return;
    }
    const [row] = await db
      .update(printBridgeProfilesTable)
      .set(updates)
      .where(
        and(
          eq(printBridgeProfilesTable.tenantId, tenantId),
          eq(printBridgeProfilesTable.id, id),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Bridge profile not found" });
      return;
    }
    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_BRIDGE_UPDATED",
        resourceType: "print_bridge",
        resourceId: String(row.id),
        metadata: { fields: Object.keys(updates) },
      });
    res.json(row);
  },
);

/** DELETE /api/print/bridge-profiles/:id */
router.delete(
  "/print/bridge-profiles/:id",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const tenantId = requestTenantId(req);
    await db
      .update(printBridgeProfilesTable)
      .set({ isActive: false })
      .where(
        and(
          eq(printBridgeProfilesTable.tenantId, tenantId),
          eq(printBridgeProfilesTable.id, id),
        ),
      );
    await db
      .insert(auditLogsTable)
      .values({
        tenantId,
        actorId: req.dbUser!.id,
        actorEmail: req.dbUser!.email ?? "",
        actorRole: req.dbUser!.role,
        action: "PRINT_BRIDGE_DEACTIVATED",
        resourceType: "print_bridge",
        resourceId: String(id),
        metadata: {},
      });
    res.json({ success: true });
  },
);

/** POST /api/print/bridge-profiles/:id/probe — health check a bridge profile */
router.post(
  "/print/bridge-profiles/:id/probe",
  adminOnly,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const rows = await db
      .select()
      .from(printBridgeProfilesTable)
      .where(
        and(
          eq(printBridgeProfilesTable.tenantId, requestTenantId(req)),
          eq(printBridgeProfilesTable.id, id),
        ),
      )
      .limit(1);
    const profile = rows[0];
    if (!profile) {
      res.status(404).json({ error: "Bridge profile not found" });
      return;
    }

    const TIMEOUT_MS = 5000;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const r = await fetch(`${profile.bridgeUrl}/health`, {
        headers: { "x-api-key": resolveBridgeApiKey(profile.apiKey) },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      let body: unknown;
      try {
        body = await r.json();
      } catch {
        body = null;
      }
      res.json({
        ok: r.ok && (body as { status?: string })?.status === "ok",
        httpStatus: r.status,
        bridgeUrl: profile.bridgeUrl,
        body,
      });
    } catch (err) {
      const errorText = String(err);
      const isTimeout = errorText.includes("AbortError");
      res.json({
        ok: false,
        bridgeUrl: profile.bridgeUrl,
        error: isTimeout
          ? `Timed out after ${TIMEOUT_MS}ms — bridge unreachable`
          : `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  },
);

/** POST /api/print/bridge-profiles/:id/list-printers — list CUPS printers on a bridge */
router.post(
  "/print/bridge-profiles/:id/list-printers",
  adminOnly,
  async (req, res): Promise<void> => {
    res
      .status(410)
      .json({
        error:
          "Unrestricted bridge queue discovery is disabled; register an explicit approved queue",
      });
    return;
    const id = parseInt(String(req.params.id), 10);
    const rows = await db
      .select()
      .from(printBridgeProfilesTable)
      .where(
        and(
          eq(printBridgeProfilesTable.tenantId, requestTenantId(req)),
          eq(printBridgeProfilesTable.id, id),
        ),
      )
      .limit(1);
    const profile = rows[0];
    if (!profile) {
      res.status(404).json({ error: "Bridge profile not found" });
      return;
    }

    const TIMEOUT_MS = 5000;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const r = await fetch(`${profile.bridgeUrl}/printers`, {
        headers: { "x-api-key": resolveBridgeApiKey(profile.apiKey) },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      let body: unknown;
      try {
        body = await r.json();
      } catch {
        body = null;
      }
      res.json({
        ok: r.ok,
        httpStatus: r.status,
        bridgeUrl: profile.bridgeUrl,
        body,
      });
    } catch (err) {
      const errorText = String(err);
      const isTimeout = errorText.includes("AbortError");
      res.json({
        ok: false,
        bridgeUrl: profile.bridgeUrl,
        error: isTimeout
          ? `Timed out after ${TIMEOUT_MS}ms`
          : `Connection failed: ${errorText}`,
      });
    }
  },
);

/** GET /api/print/routing/decision — show current routing decision for a test order */
router.get(
  "/print/routing/decision",
  adminOnly,
  async (req, res): Promise<void> => {
    const { resolveRoutingDecision, getActiveOperatorIp } =
      await import("../lib/printRoutingResolver.js");
    const role = (req.query.role as string) === "label" ? "label" : "receipt";
    const tenantId = requestTenantId(req);
    const fulfillmentType = req.query.fulfillmentType
      ? String(req.query.fulfillmentType)
      : undefined;
    const shippingAddress = req.query.shippingAddress
      ? String(req.query.shippingAddress)
      : undefined;

    const operatorIp = await getActiveOperatorIp(tenantId);
    const decision = await resolveRoutingDecision(
      role,
      { id: 0, tenantId, fulfillmentType, shippingAddress },
      operatorIp,
    );
    res.json({ operatorIp, decision });
  },
);

/** POST /api/print/printers/seed-defaults — upsert Pi CUPS bridge printers */
router.post(
  "/print/printers/seed-defaults",
  adminOnly,
  async (req, res): Promise<void> => {
    res
      .status(410)
      .json({
        error:
          "Unscoped printer seeding is disabled; register an explicit tenant bridge and printer",
      });
    return;
    const body = req.body ?? {};
    const piHost = process.env.PRINT_SERVER_HOST ?? "100.83.99.2";
    const defaultBridgeUrl = `http://${piHost}:3100`;
    const bridgeUrl = String(body.bridgeUrl ?? defaultBridgeUrl);
    const apiKey = String(body.apiKey ?? "");

    const defaults = [
      {
        name: "receipt",
        role: "receipt",
        connectionType: "bridge" as const,
        bridgeUrl,
        bridgePrinterName: process.env.RECEIPT_PRINTER_NAME ?? "receipt",
        apiKey: apiKey || null,
        isActive: true,
        paperWidth: "80mm",
        timeoutMs: 8000,
        copies: 1,
      },
      {
        name: "label",
        role: "label",
        connectionType: "bridge" as const,
        bridgeUrl,
        bridgePrinterName:
          process.env.LABEL_PRINTER_NAME ?? "Label_Themal_Printer",
        apiKey: apiKey || null,
        isActive: true,
        paperWidth: "58mm",
        timeoutMs: 8000,
        copies: 1,
      },
    ];

    // Also clean up any old Mac-named printers for the same roles
    const legacyNames = [
      "Reciept_POS80_Printer",
      "Label_Themal_Printer",
      "Receipt_Printer",
    ];

    const results = [];
    for (const d of defaults) {
      // Find by canonical name OR any legacy name for this role
      const existing = await db
        .select()
        .from(printPrintersTable)
        .where(eq(printPrintersTable.name, d.name))
        .limit(1);

      const legacyExisting = existing.length
        ? []
        : await db
            .select()
            .from(printPrintersTable)
            .where(inArray(printPrintersTable.name, legacyNames))
            .limit(1);

      const target = existing[0] ?? legacyExisting[0];

      if (target) {
        const updates: Record<string, unknown> = {
          name: d.name,
          role: d.role,
          connectionType: d.connectionType,
          bridgeUrl: d.bridgeUrl,
          bridgePrinterName: d.bridgePrinterName,
          isActive: d.isActive,
          paperWidth: d.paperWidth,
          timeoutMs: d.timeoutMs,
        };
        if (d.apiKey) updates.apiKey = d.apiKey;

        const [updated] = await db
          .update(printPrintersTable)
          .set(updates)
          .where(eq(printPrintersTable.id, target.id))
          .returning();
        results.push({
          action: "updated",
          id: updated.id,
          name: updated.name,
          role: updated.role,
        });
      } else {
        const [inserted] = await db
          .insert(printPrintersTable)
          .values({
            ...d,
            tenantId: requestTenantId(req),
            locationId: null,
            routingScope: "general",
          })
          .returning();
        results.push({
          action: "created",
          id: inserted.id,
          name: inserted.name,
          role: inserted.role,
        });
      }
    }

    res.json({ ok: true, bridgeUrl, results });
  },
);

// ── Users list (for profile assignment) ───────────────────────────────────
router.get("/print/users", adminOnly, async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
    })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.tenantId, requestTenantId(req)),
        eq(usersTable.isActive, true),
      ),
    )
    .orderBy(usersTable.email);
  res.json({ users: rows });
});

// ── Secure local CUPS receipt printing ────────────────────────────────────
//
// Receipt content is built entirely server-side from trusted DB data.
// Clients supply only the orderId — no receipt content, no printer commands.
// ESC/POS framing (\x1b@ reset, \x1dV1 cut) is added by escposPrinter, not here.

const staffOrAbove = requireRole("global_admin", "admin");

/**
 * POST /api/print/receipt/order/:orderId
 *
 * Fetch order from DB, render receipt body, print via `lp -d receipt`.
 * Allowed: admin, supervisor, staff.
 * Logs a print_jobs row for audit and reprint support.
 */
router.post(
  "/print/receipt/order/:orderId",
  staffOrAbove,
  async (req, res): Promise<void> => {
    res
      .status(410)
      .json({
        error:
          "Direct local CUPS printing is disabled; use the tenant-scoped registered-printer receipt endpoint",
      });
    return;
    const orderId = parseInt(String(req.params.orderId), 10);
    if (isNaN(orderId)) {
      res.status(400).json({ error: "Invalid orderId" });
      return;
    }

    const [order] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .limit(1);

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const items = await db
      .select()
      .from(orderItemsTable)
      .where(eq(orderItemsTable.orderId, orderId));

    const settings = await getSettings();
    const s = settings as Record<string, unknown>;
    const width = charWidth((s.paperWidth as string | undefined) ?? "80mm");
    const logoLines = s.includeLogo !== false ? getLogo(width) : [];

    let receiptLineNameMode: "alavont_only" | "lucifer_only" | "both" =
      "lucifer_only";
    try {
      const [adminRow] = await db
        .select({ receiptLineNameMode: adminSettingsTable.receiptLineNameMode })
        .from(adminSettingsTable)
        .limit(1);
      if (adminRow?.receiptLineNameMode) {
        receiptLineNameMode =
          adminRow.receiptLineNameMode as typeof receiptLineNameMode;
      }
    } catch {
      /* no admin settings row — use default */
    }

    const blocks = buildCustomerReceiptBlocks({
      orderId: order.id,
      orderNumber: String(order.id),
      createdAt: order.createdAt,
      fulfillmentType: "Pickup",
      paymentStatus: order.paymentStatus ?? undefined,
      paymentMethod: order.paymentMethod ?? undefined,
      notes: order.notes ?? undefined,
      items: items.map((i) => ({
        name: i.receiptName ?? i.catalogItemName,
        quantity: i.quantity,
        unitPrice: parseFloat(String(i.unitPrice)),
        totalPrice: parseFloat(String(i.totalPrice)),
      })),
      subtotal: parseFloat(String(order.subtotal)),
      tax: order.tax ? parseFloat(String(order.tax)) : undefined,
      total: parseFloat(String(order.total)),
      logoLines,
      dualBrandName: (s.brandName as string | undefined) ?? undefined,
      footerMessage: (s.footerMessage as string | undefined) ?? undefined,
      showDiscreetNotice: Boolean(s.showDiscreetNotice),
      showOperatorName: s.includeOperatorName !== false,
    });

    const body = renderBodyOnly(blocks, width);
    const printerName = process.env.RECEIPT_PRINTER_NAME || "receipt";
    const iKey = `lp:${orderId}:receipt:${Date.now()}`;

    const [job] = await db
      .insert(printJobsTable)
      .values({
        tenantId: requestTenantId(req),
        orderId: order.id,
        printerId: null,
        jobType: "receipt",
        status: "queued",
        idempotencyKey: iKey,
        renderFormat: "escpos",
        payloadJson: { orderId, printerName, receiptLineNameMode },
        renderedText: body,
        operatorUserId: req.dbUser!.id,
      })
      .returning();

    try {
      const { jobRef } = await printReceiptEscPos(body);
      await db
        .update(printJobsTable)
        .set({
          status: "printed",
          printedVia: "lp_cups",
          printedAt: new Date(),
        })
        .where(eq(printJobsTable.id, job.id));

      req.log.info(
        { event: "receipt_printed", jobId: job.id, orderId, jobRef },
        "Receipt printed via lp_cups",
      );

      res.json({ ok: true, jobId: job.id, jobRef });
    } catch (err) {
      const msg = (err as Error).message;
      await db
        .update(printJobsTable)
        .set({ status: "failed", errorMessage: msg })
        .where(eq(printJobsTable.id, job.id));

      req.log.warn(
        { event: "receipt_print_failed", jobId: job.id, orderId },
        "Receipt print failed",
      );

      res.status(500).json({ ok: false, jobId: job.id, error: msg });
    }
  },
);

/**
 * POST /api/print/receipt/jobs/:jobId/reprint
 *
 * Reprint a past receipt from its stored body text.
 * Allowed: admin, supervisor only.
 * Creates a new print_jobs row for audit trail.
 */
router.post(
  "/print/receipt/jobs/:jobId/reprint",
  adminOnly,
  async (req, res): Promise<void> => {
    res
      .status(410)
      .json({
        error:
          "Direct local CUPS reprinting is disabled; use the tenant-scoped registered-printer reprint endpoint",
      });
    return;
    const jobId = parseInt(String(req.params.jobId), 10);
    if (isNaN(jobId)) {
      res.status(400).json({ error: "Invalid jobId" });
      return;
    }

    const [original] = await db
      .select()
      .from(printJobsTable)
      .where(eq(printJobsTable.id, jobId))
      .limit(1);

    if (!original) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (!original.renderedText) {
      res
        .status(400)
        .json({ error: "Job has no stored receipt body — cannot reprint" });
      return;
    }
    const originalRenderedText = String(original.renderedText);
    if (original.renderFormat !== "escpos") {
      res
        .status(400)
        .json({
          error:
            "Job was not printed via lp_cups — use the standard reprint endpoint",
        });
      return;
    }

    const printerName = process.env.RECEIPT_PRINTER_NAME || "receipt";
    const iKey = `lp:reprint:${jobId}:${Date.now()}`;

    const [newJob] = await db
      .insert(printJobsTable)
      .values({
        tenantId: requestTenantId(req),
        orderId: original.orderId,
        printerId: null,
        jobType: "receipt",
        status: "queued",
        idempotencyKey: iKey,
        renderFormat: "escpos",
        payloadJson: { reprintOf: jobId, printerName },
        renderedText: originalRenderedText,
        operatorUserId: req.dbUser!.id,
      })
      .returning();

    try {
      const { jobRef } = await printReceiptEscPos(originalRenderedText);
      await db
        .update(printJobsTable)
        .set({
          status: "printed",
          printedVia: "lp_cups",
          printedAt: new Date(),
        })
        .where(eq(printJobsTable.id, newJob.id));

      req.log.info(
        {
          event: "receipt_reprinted",
          newJobId: newJob.id,
          originalJobId: jobId,
          jobRef,
        },
        "Receipt reprinted via lp_cups",
      );

      res.json({ ok: true, jobId: newJob.id, jobRef });
    } catch (err) {
      const msg = (err as Error).message;
      await db
        .update(printJobsTable)
        .set({ status: "failed", errorMessage: msg })
        .where(eq(printJobsTable.id, newJob.id));

      req.log.warn(
        {
          event: "receipt_reprint_failed",
          newJobId: newJob.id,
          originalJobId: jobId,
        },
        "Receipt reprint failed",
      );

      res.status(500).json({ ok: false, jobId: newJob.id, error: msg });
    }
  },
);

export default router;
