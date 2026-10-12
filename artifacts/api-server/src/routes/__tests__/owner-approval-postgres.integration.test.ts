import { describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

const clerkState = vi.hoisted(() => ({ userId: "", sessionClaims: {} as Record<string, unknown> }));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({ userId: clerkState.userId, sessionClaims: clerkState.sessionClaims })),
  clerkClient: { users: { getUser: vi.fn(async () => ({ emailAddresses: [] })), updateUserMetadata: vi.fn(async () => ({})) } },
}));

const databaseUrl = process.env.MYORDER_OWNER_APPROVAL_DATABASE_URL;
const integrationSuite = databaseUrl ? describe : describe.skip;

integrationSuite("owner approval security against isolated PostgreSQL", () => {
  it("denies unproven accounts and permits only recent configured-owner approval", async () => {
    const parsed = new URL(databaseUrl!);
    if (!parsed.pathname.includes("myorder_p0_owner_approval_")) throw new Error("Refusing non-disposable database");
    process.env.DATABASE_URL = databaseUrl;
    const ownerId = "user_configured_owner_for_pg_test";
    process.env.MYORDER_OWNER_CLERK_ID = ownerId;
    const database = await import("@workspace/db");
    const { db, usersTable, tenantsTable, auditLogsTable, notificationsTable, pool } = database;
    const { eq, and } = await import("drizzle-orm");
    const [{ default: usersRouter }, { default: shiftsRouter }] = await Promise.all([
      import("../users"), import("../shifts"),
    ]);
    const { requireAuth, loadDbUser, requireDbUser, requireApproved } = await import("../../lib/auth");
    const [tenant] = await db.select({ id: tenantsTable.id }).from(tenantsTable).limit(1);
    if (!tenant) throw new Error("Disposable database needs one tenant");
    const owner = await db.insert(usersTable).values({ clerkId: ownerId, email: "owner@test.invalid", role: "global_admin", status: "approved", tenantId: null, isActive: true }).returning({ id: usersTable.id });
    const subjectId = `user_pg_hotfix_${process.pid}_${Date.now()}`;
    const subject = await db.insert(usersTable).values({ clerkId: subjectId, email: `${subjectId}@test.invalid`, role: "csr", status: "pending", tenantId: tenant.id, isActive: true }).returning({ id: usersTable.id });
    const supervisorId = `${subjectId}_supervisor`;
    const supervisor = await db.insert(usersTable).values({ clerkId: supervisorId, email: `${supervisorId}@test.invalid`, role: "supervisor", status: "approved", approvedByClerkId: ownerId, approvedAt: new Date(), tenantId: tenant.id, isActive: true }).returning({ id: usersTable.id });
    const adminId = `${subjectId}_admin`;
    const admin = await db.insert(usersTable).values({ clerkId: adminId, email: `${adminId}@test.invalid`, role: "admin", status: "approved", approvedByClerkId: ownerId, approvedAt: new Date(), tenantId: tenant.id, isActive: true }).returning({ id: usersTable.id });
    const app = express(); app.use(express.json()); app.use("/api", usersRouter);
    const shiftApp = express(); shiftApp.use(express.json()); shiftApp.use("/api", shiftsRouter);
    const protectedApp = express();
    protectedApp.use(requireAuth, loadDbUser, requireDbUser, requireApproved);
    protectedApp.get("/api/protected-fixture", (_req, res) => res.status(200).json({ ok: true }));
    try {
      clerkState.userId = subjectId;
      clerkState.sessionClaims = { publicMetadata: { role: "global_admin", status: "approved" }, unsafeMetadata: { status: "approved" }, fva: [1, -1] };
      const pendingDenied = await supertest(app).get("/api/users");
      expect(pendingDenied.status, JSON.stringify(pendingDenied.body)).toBe(403);
      expect((await supertest(app).get("/api/admin/users/all")).status).toBe(403);
      expect((await supertest(shiftApp).get("/api/shifts/current")).status).toBe(403);
      expect((await supertest(app).patch(`/api/admin/users/${subject[0].id}/approval`).send({ approve: true })).status).toBe(403);

      for (const nonOwner of [
        supervisorId,
        adminId,
      ]) {
        clerkState.userId = nonOwner;
        clerkState.sessionClaims = { fva: [1, -1] };
        expect((await supertest(app).patch(`/api/admin/users/${subject[0].id}/approval`).send({ approve: true, tenantId: tenant.id })).status).toBe(403);
        expect((await db.select().from(auditLogsTable).where(eq(auditLogsTable.resourceId, String(subject[0].id)))).filter((row) => row.action === "APPROVE_USER")).toHaveLength(0);
      }

      clerkState.userId = subjectId;
      await db.update(usersTable).set({ status: "approved", approvedByClerkId: null, approvedAt: null }).where(eq(usersTable.id, subject[0].id));
      const missingProvenance = await supertest(app).get("/api/users");
      expect(missingProvenance.status, JSON.stringify(missingProvenance.body)).toBe(403);
      expect((await supertest(shiftApp).get("/api/shifts/current")).status).toBe(403);

      clerkState.userId = ownerId;
      clerkState.sessionClaims = { publicMetadata: { status: "pending", role: "user" } };
      const ownerProtectedAccess = await supertest(protectedApp).get("/api/protected-fixture");
      expect(ownerProtectedAccess.status, JSON.stringify(ownerProtectedAccess.body)).toBe(200);
      expect((await supertest(app).get("/api/users/me")).body.isConfiguredOwner).toBe(true);
      await db.update(usersTable).set({ status: "pending" }).where(eq(usersTable.id, owner[0].id));
      expect((await supertest(protectedApp).get("/api/protected-fixture")).status).toBe(200);
      expect((await supertest(app).get("/api/users/me")).body).toMatchObject({ status: "pending", isConfiguredOwner: true });
      await db.update(usersTable).set({ status: "approved" }).where(eq(usersTable.id, owner[0].id));

      clerkState.userId = subjectId;
      await db.update(usersTable).set({ status: "approved", approvedByClerkId: "some_other_owner", approvedAt: new Date() }).where(eq(usersTable.id, subject[0].id));
      expect((await supertest(app).get("/api/users")).status).toBe(403);
      expect((await supertest(shiftApp).get("/api/shifts/current")).status).toBe(403);

      clerkState.userId = ownerId;
      clerkState.sessionClaims = { fva: [11, -1] };
      expect((await supertest(app).patch(`/api/admin/users/${subject[0].id}/approval`).send({ approve: true, tenantId: tenant.id })).status).toBe(403);
      clerkState.sessionClaims = { fva: [1, -1] };
      const result = await supertest(app).patch(`/api/admin/users/${subject[0].id}/approval`).send({ approve: true, role: "csr", tenantId: tenant.id });
      expect(result.status).toBe(200);
      const [approved] = await db.select().from(usersTable).where(eq(usersTable.id, subject[0].id));
      expect(approved).toMatchObject({ status: "approved", approvedByClerkId: ownerId, tenantId: tenant.id });
      expect(approved.approvedAt).toBeInstanceOf(Date);
      const approvalAudit = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.actorId, owner[0].id), eq(auditLogsTable.resourceId, String(subject[0].id))));
      expect(approvalAudit).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "APPROVE_USER", actorId: owner[0].id, resourceType: "user", resourceId: String(subject[0].id) }),
      ]));
      clerkState.userId = subjectId;
      expect((await supertest(shiftApp).get("/api/shifts/current")).status).toBe(200);
      clerkState.userId = ownerId;
      const suspended = await supertest(app).patch(`/api/admin/users/${subject[0].id}/status`).send({ status: "deactivated" });
      expect(suspended.status).toBe(200);
      const [suspendedRow] = await db.select().from(usersTable).where(eq(usersTable.id, subject[0].id));
      expect(suspendedRow).toMatchObject({ status: "deactivated", approvedByClerkId: null, approvedAt: null });
      const suspensionAudit = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.actorId, owner[0].id), eq(auditLogsTable.resourceId, String(subject[0].id))));
      expect(suspensionAudit).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "UPDATE_USER_STATUS", metadata: expect.objectContaining({ newStatus: "deactivated", previousStatus: "approved" }) }),
      ]));
      clerkState.userId = subjectId;
      expect((await supertest(shiftApp).get("/api/shifts/current")).status).toBe(403);

      clerkState.userId = ownerId;
      clerkState.sessionClaims = { fva: [1, -1] };
      const revoked = await supertest(app).patch(`/api/admin/users/${subject[0].id}/approval`).send({ approve: false });
      expect(revoked.status).toBe(200);
      const [revokedRow] = await db.select().from(usersTable).where(eq(usersTable.id, subject[0].id));
      expect(revokedRow).toMatchObject({ status: "rejected", approvedByClerkId: null, approvedAt: null });
      const revocationAudit = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.actorId, owner[0].id), eq(auditLogsTable.resourceId, String(subject[0].id))));
      expect(revocationAudit).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "REJECT_USER", metadata: expect.objectContaining({ newStatus: "rejected", previousStatus: "deactivated" }) }),
      ]));
      clerkState.userId = subjectId;
      expect((await supertest(app).get("/api/users")).status).toBe(403);
    } finally {
      await db.delete(notificationsTable).where(eq(notificationsTable.userId, subject[0].id));
      await db.delete(auditLogsTable).where(and(eq(auditLogsTable.actorId, owner[0].id), eq(auditLogsTable.resourceId, String(subject[0].id))));
      await db.delete(usersTable).where(eq(usersTable.id, supervisor[0].id));
      await db.delete(usersTable).where(eq(usersTable.id, admin[0].id));
      await db.delete(usersTable).where(eq(usersTable.id, subject[0].id));
      await db.delete(usersTable).where(eq(usersTable.id, owner[0].id));
      await pool.end();
    }
  }, 30000);
});
