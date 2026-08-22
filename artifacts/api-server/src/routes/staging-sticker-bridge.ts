import { Router, type IRouter, type RequestHandler } from "express";
import { and, eq, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db, auditLogsTable, inventoryLocationsTable, printBridgeProfilesTable, printJobsTable, printPrintersTable, printRoutesTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { THANK_YOU_STICKER_ARTWORK_SHA256, THANK_YOU_STICKER_QUEUE, THANK_YOU_STICKER_TEMPLATE_VERSION } from "../lib/printRoutingResolver";
import { authenticateBridge, hashBridgeValue, sanitizeBridgeFailure, validateStickerPrinter } from "../lib/stagingStickerBridgePolicy";

const router: IRouter = Router();
const STAGING = "staging";
const MEDIA = "Custom.1.9375x1.9375in";
const RESOLUTION = "203dpi";
const DEVICE_URI_HASH = crypto.createHash("sha256").update("usb://MARKLIFE/X2?location=8343000").digest("hex");
const secretHash = hashBridgeValue;
const safeReason = sanitizeBridgeFailure;
const allowedFailures = new Set(["rejected", "printer_unavailable", "submission_failed", "submission_unknown", "cups_failed", "canceled", "timed_out"]);

type Bridge = typeof printBridgeProfilesTable.$inferSelect;

const bridgeAuth: RequestHandler = async (req, res, next) => {
  if (process.env.NODE_ENV !== STAGING || req.get("X-MyOrder-Environment") !== STAGING) { res.status(403).json({ error: "WRONG_ENVIRONMENT" }); return; }
  const bridgeId = req.get("X-MyOrder-Bridge-ID") ?? "";
  const token = (req.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bridgeId || !token) { res.status(401).json({ error: "BRIDGE_AUTH_REQUIRED" }); return; }
  const [bridge] = await db.select().from(printBridgeProfilesTable).where(and(eq(printBridgeProfilesTable.bridgeId, bridgeId), eq(printBridgeProfilesTable.environment, STAGING), eq(printBridgeProfilesTable.isActive, true))).limit(1);
  if (!bridge) { res.status(401).json({ error: "BRIDGE_AUTH_REJECTED" }); return; }
  const authentication = authenticateBridge({ nodeEnvironment: process.env.NODE_ENV, requestedEnvironment: req.get("X-MyOrder-Environment"), presentedSecret: token, credentialHash: bridge.credentialHash, bridgeEnvironment: bridge.environment, allowedJobType: bridge.allowedJobType });
  if (!authentication.ok) { res.status(authentication.error === "WRONG_ENVIRONMENT" ? 403 : 401).json({ error: authentication.error }); return; }
  res.locals.stickerBridge = bridge; next();
};

router.post("/print-bridge/v1/heartbeat", bridgeAuth, async (req, res): Promise<void> => {
  const bridge = res.locals.stickerBridge as Bridge;
  if (req.body?.queue !== THANK_YOU_STICKER_QUEUE || req.body?.environment !== STAGING) { res.status(422).json({ error: "BRIDGE_IDENTITY_MISMATCH" }); return; }
  const printerAvailability = String(req.body?.printerAvailability ?? "");
  if (!new Set(["available", "degraded", "unavailable"]).has(printerAvailability)) { res.status(422).json({ error: "INVALID_PRINTER_AVAILABILITY" }); return; }
  const deviceIdentityVerified = secretHash(String(req.body?.deviceUri ?? "")) === DEVICE_URI_HASH && req.body?.deviceIdentityVerified === true;
  if (printerAvailability === "available" && !deviceIdentityVerified) { res.status(422).json({ error: "PRINTER_DEVICE_MISMATCH" }); return; }
  const now = new Date();
  await db.update(printBridgeProfilesTable).set({ lastHeartbeatAt: now, bridgeVersion: safeReason(req.body?.bridgeVersion), lastPrinterAvailability: printerAvailability, lastPrinterReason: safeReason(req.body?.printerReason), lastPrinterCheckedAt: now }).where(and(eq(printBridgeProfilesTable.tenantId, bridge.tenantId), eq(printBridgeProfilesTable.id, bridge.id)));
  res.json({ ok: true, bridgeId: bridge.bridgeId, acceptedJobType: "thank_you_sticker", printerAvailability, deviceIdentityVerified });
});

router.post("/print-bridge/v1/claim", bridgeAuth, async (req, res): Promise<void> => {
  const bridge = res.locals.stickerBridge as Bridge;
  await db.execute(sql`UPDATE print_jobs SET status=CASE WHEN status='submitting' THEN 'submission_unknown' ELSE 'timed_out' END, final_cups_state=CASE WHEN status='submitting' THEN 'submission_unknown' ELSE 'timed_out' END, failure_reason='Bridge acknowledgement timeout; automatic retry prohibited', completed_at=now() WHERE tenant_id=${bridge.tenantId} AND bridge_profile_id=${bridge.id} AND ((status='claimed' AND claimed_at < now() - interval '5 minutes') OR (status='submitting' AND submitting_at < now() - interval '5 minutes'))`);
  const claimed = await db.transaction(async tx => {
    const result = await tx.execute(sql`UPDATE print_jobs SET status='claimed', approval_state='consumed', claimed_at=now(), bridge_profile_id=${bridge.id}, bridge_version=${safeReason(req.body?.bridgeVersion)} WHERE id=(SELECT j.id FROM print_jobs j JOIN print_routes r ON r.tenant_id=j.tenant_id AND r.location_id=j.location_id AND r.job_type=j.job_output AND r.printer_id=j.printer_id WHERE j.tenant_id=${bridge.tenantId} AND r.bridge_profile_id=${bridge.id} AND r.is_active=true AND j.status='queued' AND j.approval_state='approved' AND j.job_output='thank_you_sticker' AND j.copy_count=1 AND j.submission_attempts=0 ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1) AND status='queued' RETURNING *`);
    return (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0] ?? null;
  });
  if (!claimed) { res.status(204).end(); return; }
  const [printer] = await db.select().from(printPrintersTable).where(and(eq(printPrintersTable.tenantId, bridge.tenantId), eq(printPrintersTable.id, Number(claimed.printer_id)), eq(printPrintersTable.isActive, true))).limit(1);
  if (!printer || !validateStickerPrinter({ role: printer.role, queue: printer.bridgePrinterName, copies: printer.copies, receiptCapable: printer.receiptCapable, labelCapable: printer.labelCapable, expectedDeviceUriHash: printer.expectedDeviceUriHash, actualDeviceUri: "usb://MARKLIFE/X2?location=8343000" })) { await db.update(printJobsTable).set({ status: "rejected", failureReason: "Printer policy mismatch", completedAt: new Date() }).where(eq(printJobsTable.id, Number(claimed.id))); res.status(409).json({ error: "PRINTER_POLICY_MISMATCH" }); return; }
  res.json({ jobId: claimed.id, idempotencyKey: claimed.idempotency_key, bridgeId: bridge.bridgeId, bridgeProfileId: bridge.id, printerId: printer.id, queue: THANK_YOU_STICKER_QUEUE, jobType: "thank_you_sticker", copies: 1, media: MEDIA, resolution: RESOLUTION, horizontal: 0, vertical: 0, rotate: 0, mirror: 0, negative: 0, darkness: 10, templateVersion: claimed.template_version, artworkChecksum: claimed.artwork_checksum, imageBase64: (claimed.payload_json as { imageBase64?: string })?.imageBase64 });
});

router.post("/print-bridge/v1/jobs/:id/submitting", bridgeAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id); const bridge = res.locals.stickerBridge as Bridge;
  const [row] = await db.update(printJobsTable).set({ status: "submitting", submittingAt: new Date(), submissionAttempts: 1 }).where(and(eq(printJobsTable.id, id), eq(printJobsTable.tenantId, bridge.tenantId), eq(printJobsTable.bridgeProfileId, bridge.id), eq(printJobsTable.status, "claimed"), eq(printJobsTable.submissionAttempts, 0))).returning();
  if (!row) { res.status(409).json({ error: "DUPLICATE_SUBMISSION_PREVENTED" }); return; } res.json({ ok: true });
});

router.post("/print-bridge/v1/jobs/:id/submitted", bridgeAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id); const bridge = res.locals.stickerBridge as Bridge; const cupsJobId = Number(req.body?.cupsJobId); const requestId = String(req.body?.cupsRequestId ?? "");
  if (!Number.isInteger(cupsJobId) || cupsJobId <= 0 || !/^MARKLIFE_X2-[0-9]+$/.test(requestId)) { res.status(400).json({ error: "INVALID_CUPS_REQUEST_ID" }); return; }
  const [row] = await db.update(printJobsTable).set({ status: "submitted", submittedAt: new Date(), cupsJobId, cupsRequestId: requestId, finalCupsState: "pending" }).where(and(eq(printJobsTable.id, id), eq(printJobsTable.tenantId, bridge.tenantId), eq(printJobsTable.bridgeProfileId, bridge.id), eq(printJobsTable.status, "submitting"), eq(printJobsTable.submissionAttempts, 1))).returning();
  if (!row) { res.status(409).json({ error: "INVALID_JOB_TRANSITION" }); return; } res.json({ ok: true });
});

router.post("/print-bridge/v1/jobs/:id/complete", bridgeAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id); const bridge = res.locals.stickerBridge as Bridge;
  const [row] = await db.update(printJobsTable).set({ status: "completed", finalCupsState: "completed", completedAt: new Date(), printedAt: new Date(), printedVia: "staging_pull_bridge" }).where(and(eq(printJobsTable.id, id), eq(printJobsTable.tenantId, bridge.tenantId), eq(printJobsTable.bridgeProfileId, bridge.id), eq(printJobsTable.status, "submitted"), eq(printJobsTable.cupsRequestId, String(req.body?.cupsRequestId ?? "")))).returning();
  if (!row) { res.status(409).json({ error: "INVALID_JOB_TRANSITION" }); return; } res.json({ ok: true });
});

router.post("/print-bridge/v1/jobs/:id/fail", bridgeAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id); const bridge = res.locals.stickerBridge as Bridge; const state = String(req.body?.state ?? "");
  if (!allowedFailures.has(state)) { res.status(400).json({ error: "INVALID_FAILURE_STATE" }); return; }
  const [row] = await db.update(printJobsTable).set({ status: state, finalCupsState: state, failureReason: safeReason(req.body?.reason), completedAt: new Date() }).where(and(eq(printJobsTable.id, id), eq(printJobsTable.tenantId, bridge.tenantId), eq(printJobsTable.bridgeProfileId, bridge.id), sql`${printJobsTable.status} IN ('claimed','submitting','submitted')`)).returning();
  if (!row) { res.status(409).json({ error: "INVALID_JOB_TRANSITION" }); return; } res.json({ ok: true });
});

const admin = [requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole("global_admin", "admin")];
router.post("/print/staging-sticker/setup", ...admin, async (req, res): Promise<void> => {
  if (process.env.NODE_ENV !== STAGING) { res.status(403).json({ error: "STAGING_ONLY" }); return; }
  if (process.env.RECEIPT_PRINT_ENABLED === "true" || process.env.LABEL_PRINT_ENABLED === "true") { res.status(409).json({ error: "GENERAL_PRINTING_MUST_REMAIN_DISABLED" }); return; }
  const actor = req.dbUser!; const tenantId = actor.tenantId!; const locationId = Number(req.body?.locationId);
  const secret = process.env.STAGING_STICKER_BRIDGE_SECRET ?? ""; const bridgeId = process.env.STAGING_STICKER_BRIDGE_ID ?? "";
  if (secret.length < 32 || !/^[A-Za-z0-9._-]{8,80}$/.test(bridgeId)) { res.status(503).json({ error: "BRIDGE_SECRET_NOT_PROVISIONED" }); return; }
  const [location] = await db.select().from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.id, locationId), eq(inventoryLocationsTable.isActive, true))).limit(1);
  if (!location) { res.status(404).json({ error: "LOCATION_NOT_FOUND" }); return; }
  const [existingBridge] = await db.select().from(printBridgeProfilesTable).where(eq(printBridgeProfilesTable.bridgeId, bridgeId)).limit(1);
  if (existingBridge) {
    if (existingBridge.tenantId !== tenantId || existingBridge.locationId !== locationId || existingBridge.environment !== STAGING || existingBridge.allowedJobType !== "thank_you_sticker") { res.status(409).json({ error: "BRIDGE_REGISTRATION_CONFLICT" }); return; }
    const [existingRoute] = await db.select().from(printRoutesTable).where(and(eq(printRoutesTable.tenantId, tenantId), eq(printRoutesTable.locationId, locationId), eq(printRoutesTable.jobType, "thank_you_sticker"))).limit(1);
    const [existingPrinter] = existingRoute ? await db.select().from(printPrintersTable).where(and(eq(printPrintersTable.tenantId, tenantId), eq(printPrintersTable.id, existingRoute.printerId))).limit(1) : [];
    if (!existingRoute || !existingPrinter || existingRoute.bridgeProfileId !== existingBridge.id || existingPrinter.bridgePrinterName !== THANK_YOU_STICKER_QUEUE || existingPrinter.role !== "thank_you_sticker" || existingPrinter.receiptCapable || existingPrinter.labelCapable) { res.status(409).json({ error: "BRIDGE_REGISTRATION_INCOMPLETE" }); return; }
    res.json({ bridgeProfileId: existingBridge.id, bridgeId: existingBridge.bridgeId, printerId: existingPrinter.id, routeId: existingRoute.id, locationId, queue: THANK_YOU_STICKER_QUEUE, credentialConfigured: true, replayed: true });
    return;
  }
  const result = await db.transaction(async tx => {
    const [bridge] = await tx.insert(printBridgeProfilesTable).values({ tenantId, locationId, routingScope: "location", name: "Staging MARKLIFE X2 outbound bridge", bridgeType: "mac_studio_pull", bridgeUrl: "poll://staging-api", apiKey: "", bridgeId, environment: STAGING, allowedJobType: "thank_you_sticker", credentialHash: secretHash(secret), supportedRoles: "thank_you_sticker", isActive: true, priority: 1 }).returning();
    const [printer] = await tx.insert(printPrintersTable).values({ tenantId, locationId, routingScope: "location", name: THANK_YOU_STICKER_QUEUE, role: "thank_you_sticker", connectionType: "mac_bridge_pull", bridgeProfileId: bridge.id, bridgeUrl: "", bridgePrinterName: THANK_YOU_STICKER_QUEUE, copies: 1, paperWidth: "1.9375in", isActive: true, supportsCut: false, supportsCashDrawer: false, expectedDeviceUriHash: DEVICE_URI_HASH, receiptCapable: false, labelCapable: false }).returning();
    const [route] = await tx.insert(printRoutesTable).values({ tenantId, locationId, jobType: "thank_you_sticker", bridgeProfileId: bridge.id, printerId: printer.id, isActive: true }).returning();
    await tx.insert(auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "STAGING_STICKER_ROUTE_CREATED", resourceType: "print_route", resourceId: String(route.id), metadata: { locationId, bridgeProfileId: bridge.id, printerId: printer.id, queue: THANK_YOU_STICKER_QUEUE, jobType: "thank_you_sticker", receiptCapable: false, labelCapable: false } });
    return { bridge, printer, route };
  });
  res.status(201).json({ bridgeProfileId: result.bridge.id, bridgeId: result.bridge.bridgeId, printerId: result.printer.id, routeId: result.route.id, locationId, queue: THANK_YOU_STICKER_QUEUE, credentialConfigured: true });
});

router.post("/print/staging-sticker/jobs", ...admin, async (req, res): Promise<void> => {
  if (process.env.NODE_ENV !== STAGING) { res.status(403).json({ error: "STAGING_ONLY" }); return; }
  const actor = req.dbUser!; const tenantId = actor.tenantId!; const locationId = Number(req.body?.locationId); const authorizationRef = String(req.body?.authorizationRef ?? "").trim();
  if (!authorizationRef || authorizationRef.length > 120) { res.status(400).json({ error: "AUTHORIZATION_REFERENCE_REQUIRED" }); return; }
  const [route] = await db.select().from(printRoutesTable).where(and(eq(printRoutesTable.tenantId, tenantId), eq(printRoutesTable.locationId, locationId), eq(printRoutesTable.jobType, "thank_you_sticker"), eq(printRoutesTable.isActive, true))).limit(1);
  if (!route) { res.status(409).json({ error: "STICKER_ROUTE_NOT_READY" }); return; }
  const image = await readFile(resolve(import.meta.dirname, "assets/Thank-You-Sticker-v1-203dpi-preview.png"));
  const key = `thank-you-sticker:v1:${tenantId}:${locationId}:${authorizationRef}`;
  const [existing] = await db.select().from(printJobsTable).where(eq(printJobsTable.idempotencyKey, key)).limit(1);
  if (existing) { res.json({ jobId: existing.id, status: existing.status, approvalState: existing.approvalState, replayed: true }); return; }
  const [job] = await db.insert(printJobsTable).values({ tenantId, locationId, printerId: route.printerId, bridgeProfileId: route.bridgeProfileId, jobType: "thank_you_sticker", status: "queued", approvalState: "pending", idempotencyKey: key, renderFormat: "png", payloadJson: { imageBase64: image.toString("base64") }, renderedText: "", templateVersion: THANK_YOU_STICKER_TEMPLATE_VERSION, artworkChecksum: THANK_YOU_STICKER_ARTWORK_SHA256, copyCount: 1, media: MEDIA, resolution: RESOLUTION, maxRetries: 1, operatorUserId: actor.id }).returning();
  await db.insert(auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "STAGING_STICKER_JOB_CREATED_PENDING_APPROVAL", resourceType: "print_job", resourceId: String(job.id), metadata: { routeId: route.id, printerId: route.printerId, bridgeProfileId: route.bridgeProfileId, authorizationRef, copies: 1, media: MEDIA, resolution: RESOLUTION, templateVersion: THANK_YOU_STICKER_TEMPLATE_VERSION, artworkChecksum: THANK_YOU_STICKER_ARTWORK_SHA256 } });
  res.status(201).json({ jobId: job.id, status: job.status, approvalState: job.approvalState, replayed: false });
});

router.post("/print/staging-sticker/jobs/:id/approve", ...admin, async (req, res): Promise<void> => {
  if (process.env.NODE_ENV !== STAGING) { res.status(403).json({ error: "STAGING_ONLY" }); return; }
  const actor = req.dbUser!; const tenantId = actor.tenantId!; const id = Number(req.params.id);
  const authorizationRef = String(req.body?.authorizationRef ?? "").trim();
  if (!authorizationRef || authorizationRef.length > 120) { res.status(400).json({ error: "FRESH_AUTHORIZATION_REFERENCE_REQUIRED" }); return; }
  const [job] = await db.update(printJobsTable).set({ approvalState: "approved" }).where(and(eq(printJobsTable.tenantId, tenantId), eq(printJobsTable.id, id), eq(printJobsTable.jobType, "thank_you_sticker"), eq(printJobsTable.status, "queued"), eq(printJobsTable.approvalState, "pending"), eq(printJobsTable.submissionAttempts, 0))).returning();
  if (!job) { res.status(409).json({ error: "JOB_NOT_APPROVAL_PENDING" }); return; }
  await db.insert(auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role, action: "STAGING_STICKER_JOB_AUTHORIZED", resourceType: "print_job", resourceId: String(job.id), metadata: { authorizationRef, printerId: job.printerId, bridgeProfileId: job.bridgeProfileId, copies: 1 } });
  res.json({ jobId: job.id, status: job.status, approvalState: job.approvalState });
});

export default router;
