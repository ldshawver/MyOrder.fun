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
    const [tenant] = await db.select({ id: tenantsTable.id }).from(tenantsTable).limit(1);
    if (!tenant) throw new Error("Disposable database needs one tenant");
    const owner = await db.insert(usersTable).values({ clerkId: ownerId, email: "owner@test.invalid", role: "global_admin", status: "approved", tenantId: null, isActive: true }).returning({ id: usersTable.id });
    const subjectId = `user_pg_hotfix_${process.pid}_${Date.now()}`;
    const subject = await db.insert(usersTable).values({ clerkId: subjectId, email: `${subjectId}@test.invalid`, role: "csr", status: "pending", tenantId: tenant.id, isActive: true }).returning({ id: usersTable.id });
    const app = express(); app.use(express.json()); app.use("/api", usersRouter);
    const shiftApp = express(); shiftApp.use(express.json()); shiftApp.use("/api", shiftsRouter);
    try {
      clerkState.userId = subjectId;
      clerkState.sessionClaims = { publicMetadata: { role: "global_admin", status: "approved" }, unsafeMetadata: { status: "approved" }, fva: [1, -1] };
      expect((await supertest(app).get("/api/users")).status).toBe(403);
      expect((await supertest(app).get("/api/admin/users/all")).status).toBe(403);
      expect((await supertest(shiftApp).get("/api/shifts/current")).status).toBe(403);
      expect((await supertest(app).patch(`/api/admin/users/${subject[0].id}/approval`).send({ approve: true })).status).toBe(403);

      await db.update(usersTable).set({ status: "approved", approvedByClerkId: null, approvedAt: null }).where(eq(usersTable.id, subject[0].id));
      expect((await supertest(app).get("/api/users")).status).toBe(403);
      expect((await supertest(shiftApp).get("/api/shifts/current")).status).toBe(403);

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
      clerkState.userId = subjectId;
      expect((await supertest(shiftApp).get("/api/shifts/current")).status).toBe(200);
      clerkState.userId = ownerId;
      const suspended = await supertest(app).patch(`/api/admin/users/${subject[0].id}/status`).send({ status: "deactivated" });
      expect(suspended.status).toBe(200);
      const [suspendedRow] = await db.select().from(usersTable).where(eq(usersTable.id, subject[0].id));
      expect(suspendedRow).toMatchObject({ status: "deactivated", approvedByClerkId: null, approvedAt: null });
      clerkState.userId = subjectId;
      expect((await supertest(shiftApp).get("/api/shifts/current")).status).toBe(403);
    } finally {
      await db.delete(notificationsTable).where(eq(notificationsTable.userId, subject[0].id));
      await db.delete(auditLogsTable).where(and(eq(auditLogsTable.actorId, owner[0].id), eq(auditLogsTable.resourceId, String(subject[0].id))));
      await db.delete(usersTable).where(eq(usersTable.id, subject[0].id));
      await db.delete(usersTable).where(eq(usersTable.id, owner[0].id));
      await pool.end();
    }
  }, 30000);
});
