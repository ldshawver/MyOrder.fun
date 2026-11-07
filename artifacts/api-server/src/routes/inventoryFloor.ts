import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { requireApproved, requireAuth, loadDbUser, requireDbUser, requireRole } from "../lib/auth";
import { requireTenantContext } from "../lib/tenantContext";
import { InventoryMovementError, type InventoryMovementActor } from "../lib/inventoryMovementLedger";
import {
  FloorFlowError,
  abandonFloorSession,
  addFloorNote,
  completeFloorSession,
  createCountSession,
  createReceiveSession,
  ensureInventoryFloorSchema,
  findOpenFloorSession,
  getFloorSession,
  listRecentFloorNotes,
  loadFloorSheet,
  recordCountLine,
  recordReceiveLine,
  skipCountLine,
} from "../lib/inventoryFloor";

const router: IRouter = Router();
router.use("/admin/inventory-floor", requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext, requireRole("csr", "supervisor", "admin"));
router.use("/admin/inventory-floor", async (_req, res, next) => {
  try {
    await ensureInventoryFloorSchema();
    next();
  } catch {
    res.status(500).json({ error: "Could not prepare the inventory count." });
  }
});

const entityType = z.enum(["catalog", "non_catalog"]);
const locationId = z.number().int().positive();
const itemId = z.number().int().positive();
const attempt = z.number().int().min(1).max(20);
const noteKind = z.enum(["add_item", "change_item", "general"]);
const countStartBody = z.object({ scope: z.enum(["one", "all"]), locationId }).strict();
const receiveStartBody = z.object({
  locationId,
  reference: z.string().trim().max(240).optional(),
  supplierReference: z.string().trim().max(240).optional(),
}).strict();
const countLineBody = z.object({
  locationId,
  entityType,
  itemId,
  quantity: z.string().trim().min(1).max(32),
  attempt,
  unitCost: z.string().trim().max(32).nullable().optional(),
}).strict();
const skipBody = z.object({ locationId, entityType, itemId, attempt }).strict();
const receiveLineBody = z.object({
  entityType,
  itemId,
  quantity: z.string().trim().min(1).max(32),
  attempt,
  unitCost: z.string().trim().max(32).nullable().optional(),
}).strict();
const noteBody = z.object({
  kind: noteKind,
  body: z.string().trim().min(1).max(1000),
  locationId: locationId.nullable().optional(),
  entityType: entityType.nullable().optional(),
  itemId: itemId.nullable().optional(),
}).strict();

function tenantId(req: Request): number {
  return req.authorizedTenantId!;
}

function actor(req: Request): InventoryMovementActor {
  const user = req.dbUser!;
  return { id: user.id, email: user.email, role: user.role, ipAddress: req.ip };
}

function sessionId(req: Request): number | null {
  const value = Number(Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function sendError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof FloorFlowError) {
    res.status(error.status).json({ error: error.message, code: error.code, sessionId: error.sessionId });
    return;
  }
  if (error instanceof InventoryMovementError) {
    const needsCost = /unit cost/i.test(error.message);
    res.status(needsCost ? 422 : error.status).json({
      error: needsCost ? "Enter what each one cost so this can be saved." : error.message,
      code: needsCost ? "UNIT_COST_REQUIRED" : undefined,
    });
    return;
  }
  res.status(500).json({ error: fallback });
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

router.get("/admin/inventory-floor/sheet", async (req, res): Promise<void> => {
  try { res.json(await loadFloorSheet(tenantId(req))); }
  catch (error) { sendError(res, error, "The inventory list could not be loaded."); }
});

router.get("/admin/inventory-floor/notes", async (req, res): Promise<void> => {
  try { res.json({ notes: await listRecentFloorNotes(tenantId(req)) }); }
  catch (error) { sendError(res, error, "Notes could not be loaded."); }
});

router.get("/admin/inventory-floor/counts/open", async (req, res): Promise<void> => {
  try { res.json({ session: await findOpenFloorSession(tenantId(req), actor(req).id, "count") }); }
  catch (error) { sendError(res, error, "The open count could not be loaded."); }
});

router.get("/admin/inventory-floor/receipts/open", async (req, res): Promise<void> => {
  try { res.json({ session: await findOpenFloorSession(tenantId(req), actor(req).id, "receive") }); }
  catch (error) { sendError(res, error, "The open order could not be loaded."); }
});

router.post("/admin/inventory-floor/counts", async (req, res): Promise<void> => {
  const parsed = countStartBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose one location or the whole shop, and where to start." }); return; }
  try { res.status(201).json(await createCountSession(tenantId(req), actor(req), parsed.data.scope, parsed.data.locationId)); }
  catch (error) { sendError(res, error, "The count could not be started."); }
});

router.post("/admin/inventory-floor/receipts", async (req, res): Promise<void> => {
  const parsed = receiveStartBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose where this order is going." }); return; }
  try {
    res.status(201).json(await createReceiveSession(tenantId(req), actor(req), parsed.data.locationId, blankToNull(parsed.data.reference), blankToNull(parsed.data.supplierReference)));
  } catch (error) { sendError(res, error, "The order could not be started."); }
});

router.get("/admin/inventory-floor/counts/:sessionId", async (req, res): Promise<void> => {
  const id = sessionId(req);
  if (!id) { res.status(404).json({ error: "That count was not found." }); return; }
  try {
    const view = await getFloorSession(tenantId(req), id);
    if (!view || view.session.kind !== "count") { res.status(404).json({ error: "That count was not found." }); return; }
    res.json(view);
  } catch (error) { sendError(res, error, "The count could not be loaded."); }
});

router.get("/admin/inventory-floor/receipts/:sessionId", async (req, res): Promise<void> => {
  const id = sessionId(req);
  if (!id) { res.status(404).json({ error: "That order was not found." }); return; }
  try {
    const view = await getFloorSession(tenantId(req), id);
    if (!view || view.session.kind !== "receive") { res.status(404).json({ error: "That order was not found." }); return; }
    res.json(view);
  } catch (error) { sendError(res, error, "The order could not be loaded."); }
});

router.post("/admin/inventory-floor/counts/:sessionId/lines", async (req, res): Promise<void> => {
  const id = sessionId(req);
  const parsed = countLineBody.safeParse(req.body);
  if (!id || !parsed.success) { res.status(400).json({ error: "That count entry is incomplete." }); return; }
  try {
    const result = await recordCountLine(tenantId(req), actor(req), id, parsed.data);
    if (result.needsUnitCost) { res.status(422).json({ error: "Enter what each one cost so this can be saved.", code: "UNIT_COST_REQUIRED" }); return; }
    res.json(result.view);
  } catch (error) { sendError(res, error, "That count could not be saved."); }
});

router.post("/admin/inventory-floor/counts/:sessionId/skips", async (req, res): Promise<void> => {
  const id = sessionId(req);
  const parsed = skipBody.safeParse(req.body);
  if (!id || !parsed.success) { res.status(400).json({ error: "That skip is incomplete." }); return; }
  try { res.json(await skipCountLine(tenantId(req), actor(req), id, parsed.data)); }
  catch (error) { sendError(res, error, "That item could not be skipped."); }
});

router.post("/admin/inventory-floor/receipts/:sessionId/lines", async (req, res): Promise<void> => {
  const id = sessionId(req);
  const parsed = receiveLineBody.safeParse(req.body);
  if (!id || !parsed.success) { res.status(400).json({ error: "That arrival is incomplete." }); return; }
  try {
    const result = await recordReceiveLine(tenantId(req), actor(req), id, parsed.data);
    if (result.needsUnitCost) { res.status(422).json({ error: "Enter what each one cost so this can be added.", code: "UNIT_COST_REQUIRED" }); return; }
    res.json(result.view);
  } catch (error) { sendError(res, error, "That arrival could not be saved."); }
});

router.post("/admin/inventory-floor/counts/:sessionId/notes", async (req, res): Promise<void> => {
  await saveNote(req, res, "count");
});

router.post("/admin/inventory-floor/receipts/:sessionId/notes", async (req, res): Promise<void> => {
  await saveNote(req, res, "receive");
});

async function saveNote(req: Request, res: Response, kind: "count" | "receive"): Promise<void> {
  const id = sessionId(req);
  const parsed = noteBody.safeParse(req.body);
  if (!id || !parsed.success) { res.status(400).json({ error: "Write the note, and say what kind it is." }); return; }
  try {
    const view = await getFloorSession(tenantId(req), id);
    if (!view || view.session.kind !== kind) { res.status(404).json({ error: kind === "count" ? "That count was not found." : "That order was not found." }); return; }
    const note = await addFloorNote(tenantId(req), actor(req), id, parsed.data);
    res.status(201).json({ note });
  } catch (error) { sendError(res, error, "The note could not be saved."); }
}

router.post("/admin/inventory-floor/counts/:sessionId/complete", async (req, res): Promise<void> => {
  await finish(req, res, "count", "completed");
});

router.post("/admin/inventory-floor/counts/:sessionId/abandon", async (req, res): Promise<void> => {
  await finish(req, res, "count", "abandoned");
});

router.post("/admin/inventory-floor/receipts/:sessionId/complete", async (req, res): Promise<void> => {
  await finish(req, res, "receive", "completed");
});

router.post("/admin/inventory-floor/receipts/:sessionId/abandon", async (req, res): Promise<void> => {
  await finish(req, res, "receive", "abandoned");
});

async function finish(req: Request, res: Response, kind: "count" | "receive", status: "completed" | "abandoned"): Promise<void> {
  const id = sessionId(req);
  if (!id) { res.status(404).json({ error: "That session was not found." }); return; }
  try {
    const view = status === "completed"
      ? await completeFloorSession(tenantId(req), actor(req), id, kind)
      : await abandonFloorSession(tenantId(req), actor(req), id, kind);
    res.json(view);
  } catch (error) { sendError(res, error, "That session could not be closed."); }
}

export default router;
