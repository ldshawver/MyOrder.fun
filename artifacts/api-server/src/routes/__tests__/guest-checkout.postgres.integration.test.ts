/** PostgreSQL-backed security regression tests for staff guest-session creation. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

type Actor = { id: number; role: string; email: string; tenantId: number };
const state = vi.hoisted(() => ({ actor: undefined as Actor | undefined, audits: [] as Array<Record<string, unknown>> }));

vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as express.Request & { dbUser?: Actor }).dbUser = state.actor; next(); },
  requireDbUser: (req: express.Request, res: express.Response, next: express.NextFunction) => state.actor ? next() : res.status(401).json({ error: "Authentication required" }),
  requireApproved: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  normalizeRole: (role: string) => role,
  writeAuditLog: vi.fn(async (entry: Record<string, unknown>) => { state.audits.push(entry); }),
}));
vi.mock("../../lib/tenantContext", () => ({
  requireTenantContext: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!state.actor) { res.status(401).json({ error: "Authentication required" }); return; }
    (req as express.Request & { authorizedTenantId?: number }).authorizedTenantId = state.actor.tenantId;
    next();
  },
}));

const databaseUrl = process.env.MYORDER_GUEST_TEST_DATABASE_URL;
const pgSuite = databaseUrl ? describe : describe.skip;

pgSuite("POST /guest-checkout/sessions (disposable PostgreSQL)", () => {
  let dbModule: typeof import("@workspace/db");
  let request: ReturnType<typeof supertest>;
  let tenantOne: number;
  let tenantTwo: number;
  let csrOne: Actor;
  let csrTwo: Actor;
  let inactiveCsr: Actor;
  let customer: Actor;

  const payload = (key: string, displayName = "Guest Customer") => ({
    displayName,
    phone: "+15555550123",
    deliveryAddress: "1 Synthetic Lane",
    idempotencyKey: key,
  });

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!/^(127\.0\.0\.1|localhost|::1)$/.test(parsed.hostname) || !/^myorder_p0_owner_approval_guest_checkout_/.test(decodeURIComponent(parsed.pathname.slice(1)))) {
      throw new Error("Refusing a non-disposable guest-checkout database");
    }
    process.env.DATABASE_URL = databaseUrl;
    process.env.DB_SSL = "false";
    dbModule = await import("@workspace/db");
    const { db, pool, tenantsTable, usersTable, labTechShiftsTable } = dbModule;
    await pool.query("TRUNCATE TABLE tenants RESTART IDENTITY CASCADE");
    const tenants = await db.insert(tenantsTable).values([
      { name: "Guest One", slug: "guest-one", status: "active" },
      { name: "Guest Two", slug: "guest-two", status: "active" },
    ]).returning();
    tenantOne = tenants[0]!.id; tenantTwo = tenants[1]!.id;
    const rows = await db.insert(usersTable).values([
      { clerkId: "guest-csr-one", email: "csr-one@example.invalid", role: "csr", tenantId: tenantOne, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: "guest-csr-two", email: "csr-two@example.invalid", role: "csr", tenantId: tenantTwo, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: "guest-csr-inactive", email: "csr-inactive@example.invalid", role: "csr", tenantId: tenantOne, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
      { clerkId: "guest-customer", email: "customer@example.invalid", role: "user", tenantId: tenantOne, status: "approved", identityStatus: "verified", provisioningStatus: "active" },
    ]).returning();
    csrOne = { id: rows[0]!.id, role: "csr", email: rows[0]!.email!, tenantId: tenantOne };
    csrTwo = { id: rows[1]!.id, role: "csr", email: rows[1]!.email!, tenantId: tenantTwo };
    inactiveCsr = { id: rows[2]!.id, role: "csr", email: rows[2]!.email!, tenantId: tenantOne };
    customer = { id: rows[3]!.id, role: "user", email: rows[3]!.email!, tenantId: tenantOne };
    await db.insert(labTechShiftsTable).values({ tenantId: tenantOne, techId: csrOne.id, status: "active", boxAssignmentId: "guest-test-box" });
    await db.insert(labTechShiftsTable).values({ tenantId: tenantTwo, techId: csrTwo.id, status: "active", boxAssignmentId: "guest-test-box" });
    const { default: router } = await import("../guest-checkout");
    const app = express(); app.use(express.json()); app.use("/api", router); request = supertest(app);
  }, 60_000);

  beforeEach(() => { state.actor = csrOne; state.audits.length = 0; });
  afterAll(async () => { await dbModule.pool.end(); });

  it("serializes same-key concurrent requests and never discloses a capability on the replay", async () => {
    const key = "guest-session-concurrent-key-0001";
    const [left, right] = await Promise.all([
      request.post("/api/guest-checkout/sessions").send(payload(key)),
      request.post("/api/guest-checkout/sessions").send(payload(key)),
    ]);
    const winner = [left, right].find(response => response.status === 201);
    const replay = [left, right].find(response => response.status === 200);
    expect(winner?.body.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(replay?.body).toMatchObject({ sessionId: winner?.body.sessionId, capabilityIssued: false });
    expect(replay?.body).not.toHaveProperty("capability");
    const { pool } = dbModule;
    const sessions = await pool.query("SELECT capability_hash FROM guest_checkout_sessions WHERE tenant_id = $1 AND staff_actor_user_id = $2 AND idempotency_key = $3", [tenantOne, csrOne.id, key]);
    const identities = await pool.query("SELECT id FROM guest_order_identities WHERE tenant_id = $1", [tenantOne]);
    expect(sessions.rowCount).toBe(1);
    expect(identities.rowCount).toBe(1);
    expect(sessions.rows[0]!.capability_hash).not.toBe(winner!.body.capability);
    expect(JSON.stringify(state.audits)).not.toContain(winner!.body.capability);
    expect(JSON.stringify(state.audits)).not.toContain("+15555550123");
  });

  it("returns 409 for a changed fingerprint and rolls back the losing guest identity", async () => {
    const key = "guest-session-conflict-key-0002";
    expect((await request.post("/api/guest-checkout/sessions").send(payload(key, "First Guest"))).status).toBe(201);
    const changed = await request.post("/api/guest-checkout/sessions").send(payload(key, "Other Guest"));
    expect(changed.status).toBe(409);
    const rows = await dbModule.pool.query("SELECT display_name FROM guest_order_identities WHERE tenant_id = $1", [tenantOne]);
    expect(rows.rows.map(row => row.display_name)).toEqual(expect.arrayContaining(["First Guest"]));
    expect(rows.rows.map(row => row.display_name)).not.toContain("Other Guest");
  });

  it("enforces tenant, role, active-shift, and strict input boundaries", async () => {
    state.actor = inactiveCsr;
    expect((await request.post("/api/guest-checkout/sessions").send(payload("guest-session-inactive-key-03"))).status).toBe(403);
    state.actor = customer;
    expect((await request.post("/api/guest-checkout/sessions").send(payload("guest-session-role-key-00004"))).status).toBe(403);
    state.actor = csrTwo;
    const secondTenant = await request.post("/api/guest-checkout/sessions").send(payload("guest-session-isolated-key-005"));
    expect(secondTenant.status).toBe(201);
    const otherTenantSession = await dbModule.pool.query("SELECT tenant_id FROM guest_checkout_sessions WHERE id = $1", [secondTenant.body.sessionId]);
    expect(otherTenantSession.rows[0]!.tenant_id).toBe(tenantTwo);
    state.actor = csrOne;
    expect((await request.post("/api/guest-checkout/sessions").send({ ...payload("guest-session-schema-key-006"), forbidden: true })).status).toBe(400);
  });

  it("uses the repository's conditional update: rollback restores it and replay is unavailable", async () => {
    const { db, guestCheckoutSessionsTable, guestOrderIdentitiesTable } = dbModule;
    const { createGuestToken } = await import("../../lib/guestTokens");
    const { consumeGuestCheckoutCapability } = await import("../../lib/guestCheckoutSessionRepository");
    const tracking = createGuestToken("tracking");
    const capability = createGuestToken("checkout");
    const [identity] = await db.insert(guestOrderIdentitiesTable).values({
      tenantId: tenantOne, createdByUserId: csrOne.id, displayName: "Rollback Guest", trackingTokenHash: tracking.digest,
      trackingExpiresAt: new Date(Date.now() + 60_000),
    }).returning({ id: guestOrderIdentitiesTable.id });
    const [session] = await db.insert(guestCheckoutSessionsTable).values({
      tenantId: tenantOne, guestIdentityId: identity!.id, staffActorUserId: csrOne.id, capabilityHash: capability.digest,
      expiresAt: new Date(Date.now() + 60_000), idempotencyKey: "guest-session-repository-key-007", requestFingerprint: "fixture-fingerprint",
    }).returning({ id: guestCheckoutSessionsTable.id });
    await expect(db.transaction(async tx => {
      expect(await consumeGuestCheckoutCapability(tx, { sessionId: session!.id, tenantId: tenantOne, actorId: csrOne.id, capabilityDigest: capability.digest })).toMatchObject({ available: true });
      throw new Error("fixture rollback");
    })).rejects.toThrow("fixture rollback");
    await db.transaction(async tx => {
      expect(await consumeGuestCheckoutCapability(tx, { sessionId: session!.id, tenantId: tenantOne, actorId: csrOne.id, capabilityDigest: capability.digest })).toMatchObject({ available: true });
    });
    await db.transaction(async tx => {
      expect(await consumeGuestCheckoutCapability(tx, { sessionId: session!.id, tenantId: tenantOne, actorId: csrOne.id, capabilityDigest: capability.digest })).toEqual({ available: false });
      expect(await consumeGuestCheckoutCapability(tx, { sessionId: session!.id, tenantId: tenantTwo, actorId: csrOne.id, capabilityDigest: capability.digest })).toEqual({ available: false });
    });
  });
});
