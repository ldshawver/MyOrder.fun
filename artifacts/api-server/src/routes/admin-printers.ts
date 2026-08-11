/**
 * /api/admin/printers/* — Simplified printer admin surface (Task #9).
 *
 * Replaces the overloaded printer settings UI with two clear modes:
 *   - local_cups: lp -d <queue> on this VPS (primary)
 *   - bridge:    POST to the Tailscale Print Bridge
 *
 * Eight settings fields. Two test buttons. One status probe. Always JSON.
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, printSettingsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import {
  buildReceiptTestPayload,
  getBridgeUrl,
  isValidQueueName,
  printViaCups,
  printViaBridge,
  printPngLabelViaBridge,
  printPngLabelViaCups,
  type PrintMethod,
  type PrintRole,
} from "../lib/simplePrint";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);
const adminOnly = requireRole("global_admin", "admin");

// Always respond JSON: a tiny error wrapper for async handlers.
type AsyncHandler = (req: Request, res: Response) => Promise<void>;
const wrap = (h: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
  h(req, res).catch((err: Error) => {
    req.log?.error({ event: "admin_printers_error", errMsg: err.message }, "admin printers route failed");
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message || "Internal error" });
    } else {
      next(err);
    }
  });
};

const VALID_METHODS: ReadonlySet<PrintMethod> = new Set(["bridge"]);

interface SimpleSettings {
  receiptEnabled: boolean;
  receiptMethod: PrintMethod;
  receiptPrinterName: string;
  labelEnabled: boolean;
  labelMethod: PrintMethod;
  labelPrinterName: string;
  autoPrintReceipts: boolean;
  lastTestResult: unknown;
  bridgeUrl: string;
  bridgeApiKeySet: boolean;
}

async function loadOrCreateSettings(): Promise<typeof printSettingsTable.$inferSelect> {
  const rows = await db.select().from(printSettingsTable).limit(1);
  if (rows[0]) return rows[0];
  const [row] = await db.insert(printSettingsTable).values({
    receiptEnabled: true,
    receiptMethod: "bridge",
    receiptPrinterName: "receipt",
    labelEnabled: true,
    labelMethod: "local_cups",
    labelPrinterName: "Label_Themal_Printer",
  }).returning();
  return row;
}

function projectSettings(row: typeof printSettingsTable.$inferSelect): SimpleSettings {
  return {
    receiptEnabled: row.receiptEnabled,
    receiptMethod: (row.receiptMethod as PrintMethod) ?? "local_cups",
    receiptPrinterName: row.receiptPrinterName ?? "receipt",
    labelEnabled: row.labelEnabled,
    labelMethod: (row.labelMethod as PrintMethod) ?? "local_cups",
    labelPrinterName: row.labelPrinterName ?? "Label_Themal_Printer",
    autoPrintReceipts: row.autoPrintReceipts,
    lastTestResult: row.lastTestResult,
    bridgeUrl: getBridgeUrl(),
    bridgeApiKeySet: Boolean(process.env.PRINT_BRIDGE_API_KEY),
  };
}

// ── GET /api/admin/printers/settings ─────────────────────────────────────────
router.get(
  "/admin/printers/settings",
  adminOnly,
  wrap(async (_req, res) => {
    const row = await loadOrCreateSettings();
    res.json({ ok: true, settings: projectSettings(row) });
  }),
);

// ── PATCH /api/admin/printers/settings ───────────────────────────────────────
router.patch(
  "/admin/printers/settings",
  adminOnly,
  wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    const errors: string[] = [];

    const setBool = (k: keyof SimpleSettings, col: string) => {
      if (body[k] !== undefined) {
        if (typeof body[k] !== "boolean") errors.push(`${k} must be boolean`);
        else updates[col] = body[k];
      }
    };
    const setMethod = (k: "receiptMethod" | "labelMethod", col: string) => {
      if (body[k] !== undefined) {
        const v = String(body[k]);
        if (!VALID_METHODS.has(v as PrintMethod)) errors.push(`${k} must use the registered bridge path`);
        else updates[col] = v;
      }
    };
    const setName = (k: "receiptPrinterName" | "labelPrinterName", col: string) => {
      if (body[k] !== undefined) {
        const v = String(body[k] ?? "").trim();
        if (!isValidQueueName(v)) {
          errors.push(`${k} must match A–Z, 0–9, _ . - (1–64 chars)`);
        } else {
          updates[col] = v;
        }
      }
    };

    setBool("receiptEnabled", "receiptEnabled");
    setMethod("receiptMethod", "receiptMethod");
    setName("receiptPrinterName", "receiptPrinterName");
    setBool("labelEnabled", "labelEnabled");
    setMethod("labelMethod", "labelMethod");
    setName("labelPrinterName", "labelPrinterName");
    setBool("autoPrintReceipts", "autoPrintReceipts");
    if (body.receiptPrinterName !== undefined || body.labelPrinterName !== undefined) {
      errors.push("Printer queues are selected only from tenant-owned registered printers");
    }

    if (errors.length) {
      res.status(400).json({ ok: false, errors });
      return;
    }

    const existing = await loadOrCreateSettings();
    const updated = Object.keys(updates).length
      ? await db
          .update(printSettingsTable)
          .set(updates)
          .where(sqlIdEq(existing.id))
          .returning()
      : [existing];

    res.json({ ok: true, settings: projectSettings(updated[0]) });
  }),
);

// drizzle eq helper, lazy-imported to avoid pulling sql module into top-level
import { eq } from "drizzle-orm";
function sqlIdEq(id: number) {
  return eq(printSettingsTable.id, id);
}

async function recordLastTest(role: PrintRole, mode: PrintMethod, ok: boolean, message: string) {
  try {
    const existing = await loadOrCreateSettings();
    await db
      .update(printSettingsTable)
      .set({
        lastTestResult: { ts: new Date().toISOString(), role, mode, ok, message },
      })
      .where(sqlIdEq(existing.id));
  } catch {
    /* persisting last-test summary is best-effort */
  }
}

async function runTest(role: PrintRole, req: Request, res: Response) {
  res.status(410).json({ ok: false, role, error: "Legacy direct test printing is disabled; use the tenant-scoped registered-printer test endpoint" });
  return;
  const settings = projectSettings(await loadOrCreateSettings());
  const enabled = role === "receipt" ? settings.receiptEnabled : settings.labelEnabled;
  const method = role === "receipt" ? settings.receiptMethod : settings.labelMethod;
  const name = role === "receipt" ? settings.receiptPrinterName : settings.labelPrinterName;

  if (!enabled) {
    const msg = `${role === "receipt" ? "Receipt" : "Label"} printing is disabled in settings.`;
    await recordLastTest(role, method, false, msg);
    res.status(412).json({ ok: false, role, mode: method, printerName: name, message: msg });
    return;
  }

  let result;
  if (role === "label") {
    const { generateThankYouLabelTest } = await import("../lib/print/templates/thankYouLabel.js");
    const png = await generateThankYouLabelTest();
    result = method === "bridge"
      ? await printPngLabelViaBridge(name, png)
      : await printPngLabelViaCups(name, png);
  } else {
    const payload = buildReceiptTestPayload();
    result = method === "bridge"
      ? await printViaBridge(role, name, payload)
      : await printViaCups(name, payload);
  }

  await recordLastTest(role, method, result.ok, result.message);
  req.log?.info(
    { event: "admin_test_print", role, mode: method, ok: result.ok, printerName: name },
    "admin test print",
  );

  res.status(result.ok ? 200 : 502).json({ ...result, role });
}

// ── POST /api/admin/printers/test-receipt ────────────────────────────────────
router.post(
  "/admin/printers/test-receipt",
  adminOnly,
  wrap((req, res) => runTest("receipt", req, res)),
);

// ── POST /api/admin/printers/test-label ──────────────────────────────────────
router.post(
  "/admin/printers/test-label",
  adminOnly,
  wrap((req, res) => runTest("label", req, res)),
);

// ── GET /api/admin/printers/status ───────────────────────────────────────────
router.get(
  "/admin/printers/status",
  adminOnly,
  wrap(async (_req, res) => {
    res.status(410).json({ ok: false, error: "Unrestricted CUPS discovery is disabled; use tenant-owned registered printer health" });
  }),
);

export default router;
