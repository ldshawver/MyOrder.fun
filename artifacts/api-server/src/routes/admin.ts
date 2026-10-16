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
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved, requireRecentOwnerAuth, writeAuditLog } from "../lib/auth";
import { requirePermission } from "../lib/roles";
import { generateSecret, generateURI, verifySync } from "otplib";
import qrcode from "qrcode";
import crypto from "crypto";
import { z } from "zod";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole("admin"));

// GET /api/admin/stats
router.get("/admin/stats", requirePermission("platform.tenants.view"), async (req, res): Promise<void> => {
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
      tenantId: e.tenantId ?? undefined,
      actorId: e.actorId,
      actorEmail: e.actorEmail,
      actorRole: e.actorRole,
      action: e.action,
      resourceType: e.resourceType ?? undefined,
      resourceId: e.resourceId ?? undefined,
      metadata: e.metadata ?? undefined,
      ipAddress: e.ipAddress ?? undefined,
      createdAt: e.createdAt,
    })),
  }));
});

// POST /api/admin/mfa/setup
router.post("/admin/mfa/setup", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const secret = generateSecret();
  const otpauth = generateURI({ label: actor.email ?? "unknown", issuer: "OrderFlow Admin", secret });
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

  const isValid = verifySync({ token: body.data.token, secret: actor.mfaSecret });
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

const purgeBodySchema = z.object({ confirm: z.literal("PURGE_ALL_SESSIONS") }).strict();

// POST /api/admin/purge — platform-wide emergency maintenance operation.
// The router's admin role gate includes tenant_admin for tenant operations, so
// this route adds the platform permission and recent-auth checks explicitly.
router.post("/admin/purge", requirePermission("platform.global_settings.manage"), requireRecentOwnerAuth, async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const parsed = purgeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid purge request" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const activeOrders = await tx
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(notInArray(ordersTable.status, ["delivered", "cancelled"]));
    const activeIds = activeOrders.map(o => o.id);

    if (activeIds.length > 0) {
      await tx.delete(orderNotesTable).where(inArray(orderNotesTable.orderId, activeIds));
      await tx.delete(orderItemsTable).where(inArray(orderItemsTable.orderId, activeIds));
      await tx.delete(ordersTable).where(inArray(ordersTable.id, activeIds));
    }

    const deletedNotifications = await tx.delete(notificationsTable).where(eq(notificationsTable.isRead, false)).returning({ id: notificationsTable.id });
    await tx.insert(auditLogsTable).values({
      actorId: actor.id,
      actorEmail: actor.email ?? "",
      actorRole: actor.role,
      action: "EMERGENCY_PURGE",
      tenantId: null,
      resourceType: "platform",
      resourceId: "all",
      metadata: { scope: "platform", purgedOrderCount: activeIds.length, purgedNotificationCount: deletedNotifications.length },
      ipAddress: req.ip ?? null,
    });
    return { orderCount: activeIds.length, notificationCount: deletedNotifications.length };
  });

  res.json({ purged: true, ordersDeleted: result.orderCount, notificationsDeleted: result.notificationCount });
});

export default router;
