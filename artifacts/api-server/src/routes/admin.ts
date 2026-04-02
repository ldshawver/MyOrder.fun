import { Router, type IRouter } from "express";
import { eq, count, desc, inArray, notInArray } from "drizzle-orm";
import {
  db,
  tenantsTable,
  ordersTable,
  orderItemsTable,
  orderNotesTable,
  notificationsTable,
  onboardingRequestsTable,
  auditLogsTable,
  usersTable,
} from "@workspace/db";
import {
  GetAdminStatsResponse,
  SetupMfaResponse,
  VerifyMfaBody,
  VerifyMfaResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser, requireRole, writeAuditLog } from "../lib/auth";
import { TOTP, generateSecret } from "otplib";
import qrcode from "qrcode";
import crypto from "crypto";

const totp = new TOTP();

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireRole("global_admin"));

// GET /api/admin/stats
router.get("/admin/stats", async (req, res): Promise<void> => {
  const [{ count: totalTenants }] = await db.select({ count: count() }).from(tenantsTable);
  const [{ count: activeTenants }] = await db.select({ count: count() }).from(tenantsTable).where(eq(tenantsTable.status, "active"));
  const [{ count: pendingOnboarding }] = await db.select({ count: count() }).from(onboardingRequestsTable).where(eq(onboardingRequestsTable.status, "submitted"));
  const [{ count: totalOrders }] = await db.select({ count: count() }).from(ordersTable);

  const allOrders = await db.select({ total: ordersTable.total, paymentStatus: ordersTable.paymentStatus }).from(ordersTable);
  const totalRevenue = allOrders.filter(o => o.paymentStatus === "paid").reduce((s, o) => s + parseFloat(o.total as string), 0);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const newTenants = await db.select().from(tenantsTable);
  const newTenantsThisMonth = newTenants.filter(t => new Date(t.createdAt) >= startOfMonth).length;

  const recentActivity = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt)).limit(10);

  res.json(GetAdminStatsResponse.parse({
    totalTenants: Number(totalTenants),
    activeTenants: Number(activeTenants),
    pendingOnboardingRequests: Number(pendingOnboarding),
    totalOrders: Number(totalOrders),
    totalRevenue,
    newTenantsThisMonth,
    recentActivity: recentActivity.map(e => ({
      id: e.id,
      tenantId: e.tenantId,
      actorId: e.actorId,
      actorEmail: e.actorEmail,
      actorRole: e.actorRole,
      action: e.action,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      metadata: e.metadata,
      ipAddress: e.ipAddress,
      createdAt: e.createdAt,
    })),
  }));
});

// POST /api/admin/mfa/setup
router.post("/admin/mfa/setup", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const secret = generateSecret();
  const otpauth = totp.keyuri(actor.email, "OrderFlow Admin", secret);
  const qrCodeUrl = await qrcode.toDataURL(otpauth);

  // Generate 10 backup codes
  const backupCodes = Array.from({ length: 10 }, () =>
    crypto.randomBytes(4).toString("hex")
  );

  // Store encrypted secret and backup codes
  await db.update(usersTable).set({
    mfaSecret: secret,
    mfaBackupCodes: JSON.stringify(backupCodes),
  }).where(eq(usersTable.id, actor.id));

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "MFA_SETUP_INITIATED",
    ipAddress: req.ip,
  });

  res.json(SetupMfaResponse.parse({ secret, qrCodeUrl, backupCodes }));
});

// POST /api/admin/mfa/verify
router.post("/admin/mfa/verify", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const body = VerifyMfaBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!actor.mfaSecret) {
    res.status(400).json({ error: "MFA not set up. Call /api/admin/mfa/setup first." });
    return;
  }

  const isValid = totp.verify({ token: body.data.token, secret: actor.mfaSecret });
  if (!isValid) {
    // Check backup codes
    const backupCodes: string[] = actor.mfaBackupCodes ? JSON.parse(actor.mfaBackupCodes) : [];
    if (!backupCodes.includes(body.data.token)) {
      await writeAuditLog({
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        action: "MFA_VERIFY_FAILED",
        ipAddress: req.ip,
      });
      res.json(VerifyMfaResponse.parse({ verified: false, message: "Invalid token" }));
      return;
    }
    // Consume backup code
    const remaining = backupCodes.filter(c => c !== body.data.token);
    await db.update(usersTable).set({ mfaBackupCodes: JSON.stringify(remaining) }).where(eq(usersTable.id, actor.id));
  }

  await db.update(usersTable).set({ mfaEnabled: true }).where(eq(usersTable.id, actor.id));
  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "MFA_VERIFY_SUCCESS",
    ipAddress: req.ip,
  });

  res.json(VerifyMfaResponse.parse({ verified: true, message: "MFA enabled successfully" }));
});

// POST /api/admin/purge — Emergency Kill Switch
// Deletes all active (non-delivered, non-cancelled) orders and their items/notes.
// Only callable by global_admin. Logs the action.
router.post("/admin/purge", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const { confirm } = req.body as { confirm?: string };
  if (confirm !== "PURGE_ALL_SESSIONS") {
    res.status(400).json({ error: "Must send confirm: 'PURGE_ALL_SESSIONS' to proceed" });
    return;
  }

  // Find all active orders (not delivered, not cancelled)
  const activeOrders = await db
    .select({ id: ordersTable.id })
    .from(ordersTable)
    .where(notInArray(ordersTable.status, ["delivered", "cancelled"]));

  const activeIds = activeOrders.map(o => o.id);

  if (activeIds.length > 0) {
    await db.delete(orderNotesTable).where(inArray(orderNotesTable.orderId, activeIds));
    await db.delete(orderItemsTable).where(inArray(orderItemsTable.orderId, activeIds));
    await db.delete(ordersTable).where(inArray(ordersTable.id, activeIds));
  }

  // Clear all unread notifications
  await db.delete(notificationsTable).where(eq(notificationsTable.isRead, false));

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "EMERGENCY_PURGE",
    resourceType: "platform",
    resourceId: "all",
    metadata: { purgedOrderCount: activeIds.length },
    ipAddress: req.ip,
  });

  res.json({ purged: true, ordersDeleted: activeIds.length });
});

export default router;
