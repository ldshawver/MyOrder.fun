/**
 * CSR / Sales-Rep / Lab-Tech shift tests
 *
 * Verifies that the new staff roles introduced in stab-02 can:
 *  - pass the requireRole gate on /api/shifts/clock-in
 *  - bypass requireApproved even when status="pending" (staff is implicitly approved)
 *  - get a 200 + { alreadyClockedIn: true } on duplicate clock-in
 *  - cause writeAuditLog to fire on clock-out
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

let mockUserId: string | null = "csr-clerk-id";

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => (mockUserId ? { userId: mockUserId } : {})),
}));

const auditLogInsertSpy = vi.fn();

// Each call to .where()/.from()/.orderBy() in real drizzle returns a
// thenable that ALSO supports further chaining (.limit/.orderBy/etc).
// Mirror that here so `await select().from().where()` works AND
// `await select().from().where().limit(1)` / `.orderBy(...)` also work.
const thenableChain = (resolved: unknown[]): Record<string, unknown> => {
  const promise = Promise.resolve(resolved);
  const obj = promise as unknown as Record<string, unknown>;
  obj.limit = () => Promise.resolve(resolved);
  obj.orderBy = () => Promise.resolve(resolved);
  obj.where = vi.fn(() => thenableChain(resolved));
  obj.from = vi.fn(() => thenableChain(resolved));
  return obj;
};
const makeChain = (resolved: unknown[]) => thenableChain(resolved);

vi.mock("@workspace/db", () => {
  const usersTable = { clerkId: "clerkId_col", id: "id_col", email: "email_col", firstName: "firstName_col", lastName: "lastName_col" };
  const labTechShiftsTable = { techId: "techId_col", status: "status_col", id: "id_col" };
  const shiftInventoryItemsTable = { shiftId: "shiftId_col", displayOrder: "displayOrder_col", id: "id_col" };
  const inventoryTemplatesTable = { isActive: "isActive_col", displayOrder: "displayOrder_col", tenantId: "tenantId_col" };
  const catalogItemsTable = {
    isAvailable: "isAvailable_col",
    isLocalAlavont: "isLocalAlavont_col",
    alavontCategory: "alavontCategory_col",
    name: "name_col",
  };
  const ordersTable = { assignedShiftId: "assignedShiftId_col", id: "id_col", customerId: "customerId_col" };
  const orderItemsTable = { orderId: "orderId_col" };
  const auditLogsTable = {};
  const csrBoxesTable = { id: "id_col", tenantId: "tenantId_col", slug: "slug_col", label: "label_col", isActive: "isActive_col", displayOrder: "displayOrder_col" };
  const inventoryLocationsTable = { id: "id_col", tenantId: "tenantId_col", name: "name_col", type: "type_col", isActive: "isActive_col", displayOrder: "displayOrder_col" };
  const inventoryBalancesTable = { id: "id_col", tenantId: "tenantId_col", productId: "productId_col", locationId: "locationId_col", quantityOnHand: "quantityOnHand_col" };
  const adminSettingsTable = {};

  const db = {
    execute: vi.fn(() => Promise.resolve()),
    select: vi.fn(),
    insert: vi.fn((table: unknown) => {
      if (table === auditLogsTable) {
        return {
          values: vi.fn((vals: unknown) => {
            auditLogInsertSpy(vals);
            return Promise.resolve(undefined);
          }),
        };
      }
      // shift insert: .values(...).returning() must yield [{ id, ... }]
      return {
        values: vi.fn(() => ({
          returning: () => Promise.resolve([{ id: 999, tenantId: 1, techId: 50, status: "active", clockedInAt: new Date(), cashBankStart: "0" }]),
        })),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: () => Promise.resolve([{ id: 999, status: "supervisor_pending", clockedOutAt: new Date() }]),
        })),
      })),
    })),
    delete: vi.fn(),
  };

  return { db, usersTable, labTechShiftsTable, shiftInventoryItemsTable, inventoryTemplatesTable, catalogItemsTable, ordersTable, orderItemsTable, auditLogsTable, csrBoxesTable, inventoryLocationsTable, inventoryBalancesTable, adminSettingsTable };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  and: vi.fn((...args) => args),
  asc: vi.fn((c) => c),
  desc: vi.fn((c) => c),
  sql: vi.fn(),
  inArray: vi.fn(() => ({})),
}));

vi.mock("../../lib/singleTenant", () => ({ getHouseTenantId: vi.fn().mockResolvedValue(1) }));
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
}));

import { db } from "@workspace/db";
import shiftsRouter from "../shifts";

function makeUser(role: string, status: string = "pending", isActive = true) {
  return { id: 50, clerkId: "csr-clerk-id", email: "csr@example.com", firstName: "Marek", lastName: "C", role, status, isActive };
}

/**
 * Wires the db.select mock so:
 *   call 1 = user lookup (loadDbUser)
 *   call 2 = active-shift lookup (clock-in / clock-out)
 *   call 3+ = empty (orders / inventory snapshot lookups)
 */
function configureDb(opts: { user: ReturnType<typeof makeUser> | null; activeShift?: unknown }) {
  let n = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    n++;
    if (n === 1) return makeChain(opts.user ? [opts.user] : []);
    if (n === 2 && opts.activeShift) return makeChain([opts.activeShift]);
    return makeChain([]);
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
    next();
  });
  app.use("/api", shiftsRouter);
  return app;
}

describe("Shifts: CSR / sales_rep / lab_tech can operate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditLogInsertSpy.mockClear();
    mockUserId = "csr-clerk-id";
  });

  for (const role of ["customer_service_rep", "Customer Service Rep", "CSR", "service_rep", "sales_rep", "lab_tech", "lab_technician", "global_admin"] as const) {
    it(`role=${role} (status=pending) is allowed past requireApproved + requireRole on clock-in`, async () => {
      configureDb({ user: makeUser(role, "pending") });
      const res = await supertest(buildApp()).post("/api/shifts/clock-in").send({});
      // Must NOT be 403 (approval gate) and must NOT be 403/forbidden role gate
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(201);
      expect(res.body.shift).toBeDefined();
    });
  }

  it("approved CSR clock-in returns 201 with shift", async () => {
    configureDb({ user: makeUser("customer_service_rep", "approved") });
    const res = await supertest(buildApp()).post("/api/shifts/clock-in").send({});
    expect(res.status).toBe(201);
    expect(res.body.shift).toBeDefined();
  });

  it("duplicate clock-in returns 200 with existing shift instead of erroring", async () => {
    const activeShift = { id: 777, techId: 50, status: "active", tenantId: 1, clockedInAt: new Date(), cashBankStart: "0" };
    configureDb({ user: makeUser("customer_service_rep", "approved"), activeShift });
    const res = await supertest(buildApp()).post("/api/shifts/clock-in").send({});
    expect(res.status).toBe(200);
    expect(res.body.alreadyClockedIn).toBe(true);
    expect(res.body.shift.id).toBe(777);
  });

  it("clock-out writes an audit_logs row with action=shift.clock_out", async () => {
    const activeShift = { id: 888, techId: 50, status: "active", tenantId: 1, clockedInAt: new Date(), cashBankStart: "0" };
    configureDb({ user: makeUser("customer_service_rep", "approved"), activeShift });
    const res = await supertest(buildApp()).post("/api/shifts/clock-out").send({ cashBankEnd: 100 });
    expect(res.status).toBe(200);
    expect(auditLogInsertSpy).toHaveBeenCalledTimes(1);
    const row = auditLogInsertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(row.action).toBe("shift.clock_out");
    expect(row.actorId).toBe(50);
    expect(row.actorRole).toBe("csr");
    expect(row.resourceType).toBe("lab_tech_shift");
    expect(row.resourceId).toBe("888");
  });


  it("inactive approved CSR is blocked before clock-in", async () => {
    configureDb({ user: makeUser("customer_service_rep", "approved", false) });
    const res = await supertest(buildApp()).post("/api/shifts/clock-in").send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/deactivated/i);
  });

  it("rejected CSR is blocked before clock-in", async () => {
    configureDb({ user: makeUser("customer_service_rep", "rejected") });
    const res = await supertest(buildApp()).post("/api/shifts/clock-in").send({});
    expect(res.status).toBe(403);
    expect(res.body.status).toBe("rejected");
  });

  it("plain status=pending user (role=user) is still blocked with 403", async () => {
    configureDb({ user: makeUser("user", "pending") });
    const res = await supertest(buildApp()).post("/api/shifts/clock-in").send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/pending approval/i);
  });

  it("GET /api/shifts/active alias works for CSR (returns shift:null when none)", async () => {
    configureDb({ user: makeUser("customer_service_rep", "approved") });
    const res = await supertest(buildApp()).get("/api/shifts/active");
    expect(res.status).toBe(200);
    expect(res.body.shift).toBeNull();
  });

  // ── Router-order regression tests ──────────────────────────────────────────
  // Guards against the bug where auditRouter AND adminRouter (both have
  // router.use(requireRole(...)) without a path prefix) were mounted before
  // shiftsRouter and blocked CSR requests with 403 before they could reach
  // the shift handlers.
  //
  // VPS-confirmed fix: index.ts order must be:
  //   notificationsRouter → shiftsRouter → auditRouter → adminRouter
  //
  // These tests reproduce both problematic routers and verify the fix holds.

  it("auditRouter requireRole guard (global_admin/admin only) does not intercept /api/shifts/* when mounted after shiftsRouter", async () => {
    configureDb({ user: makeUser("customer_service_rep", "approved") });
    const auditOnlyApp = express();
    auditOnlyApp.use(express.json());
    auditOnlyApp.use((req, _res, next) => {
      (req as unknown as Record<string, unknown>).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
      next();
    });
    // Simulate auditRouter middleware (no path prefix, global_admin/admin only) — AFTER shifts
    const mockAuditRouter = express.Router();
    mockAuditRouter.use((_req, res, next) => {
      const user = (_req as unknown as Record<string, unknown>).dbUser as { role?: string } | undefined;
      const role = user?.role ?? "";
      if (role !== "admin" && role !== "global_admin") {
        res.status(403).json({ error: "Forbidden: audit/admin only" });
        return;
      }
      next();
    });
    mockAuditRouter.get("/audit", (_req, res) => res.json({ entries: [] }));
    // CORRECT ordering: shifts first, audit after
    auditOnlyApp.use("/api", shiftsRouter);
    auditOnlyApp.use("/api", mockAuditRouter);

    const shiftRes = await supertest(auditOnlyApp).get("/api/shifts/current");
    expect(shiftRes.status).toBe(200);

    // Audit route still blocked for CSR
    configureDb({ user: makeUser("customer_service_rep", "approved") });
    const auditRes = await supertest(auditOnlyApp).get("/api/audit");
    expect(auditRes.status).toBe(403);
  });

  it("auditRouter mounted BEFORE shiftsRouter blocks CSR from shift routes (reproduces pre-fix bug)", async () => {
    configureDb({ user: makeUser("customer_service_rep", "approved") });
    const brokenAuditApp = express();
    brokenAuditApp.use(express.json());
    brokenAuditApp.use((req, _res, next) => {
      (req as unknown as Record<string, unknown>).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
      next();
    });
    const mockAuditRouter = express.Router();
    mockAuditRouter.use((_req, res, next) => {
      const user = (_req as unknown as Record<string, unknown>).dbUser as { role?: string } | undefined;
      const role = user?.role ?? "";
      if (role !== "admin" && role !== "global_admin") {
        res.status(403).json({ error: "Forbidden: audit/admin only" });
        return;
      }
      next();
    });
    // BUG: audit before shifts — CSR should be blocked
    brokenAuditApp.use("/api", mockAuditRouter);
    brokenAuditApp.use("/api", shiftsRouter);

    const res = await supertest(brokenAuditApp).get("/api/shifts/current");
    expect(res.status).toBe(403);
  });

  it("approved CSR can access GET /api/shifts/current and receives { shift: null } when no active shift", async () => {
    configureDb({ user: makeUser("customer_service_rep", "approved") });
    const res = await supertest(buildApp()).get("/api/shifts/current");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("shift", null);
  });

  it("approved CSR can access GET /api/shifts/inventory-template and does not receive a generic admin-only 403", async () => {
    configureDb({ user: makeUser("customer_service_rep", "approved") });
    const res = await supertest(buildApp()).get("/api/shifts/inventory-template");
    // Must not be blocked by an admin-role gate (403 with "insufficient role" from admin middleware)
    expect(res.status).not.toBe(403);
    if (res.status === 403) {
      // Surface the exact reason so future failures are easy to read
      expect(res.body).not.toMatchObject({ failedCondition: "csr_role_required" });
    }
  });

  it("non-admin CSR is blocked when an admin-only gate comes before the shift handler (regression guard)", async () => {
    // Build a composite app that reproduces the pre-fix ordering bug:
    // admin-only middleware BEFORE the shifts router. The CSR must be blocked.
    configureDb({ user: makeUser("customer_service_rep", "approved") });
    const brokenApp = express();
    brokenApp.use(express.json());
    brokenApp.use((req, _res, next) => {
      (req as unknown as Record<string, unknown>).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
      next();
    });
    // Simulate an admin-gated router mounted BEFORE shiftsRouter (the old bug)
    const mockAdminRouter = express.Router();
    mockAdminRouter.use((_req, res, next) => {
      const user = (_req as unknown as Record<string, unknown>).dbUser as { role?: string } | undefined;
      const role = user?.role ?? "";
      if (role !== "admin" && role !== "global_admin") {
        res.status(403).json({ error: "Forbidden: admin only" });
        return;
      }
      next();
    });
    mockAdminRouter.get("/admin/settings", (_req, res) => res.json({ settings: {} }));
    brokenApp.use("/api", mockAdminRouter);
    brokenApp.use("/api", shiftsRouter);

    const res = await supertest(brokenApp).get("/api/shifts/current");
    // With old ordering, CSR gets 403 from the admin middleware
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin only/i);
  });

  it("non-admin CSR cannot access true admin routes (GET /api/admin/settings) via the shifts app", async () => {
    // Build a composite app with the CORRECT ordering (shifts before admin-like router)
    // and verify CSR still cannot reach admin-gated endpoints.
    configureDb({ user: makeUser("customer_service_rep", "approved") });
    const fixedApp = express();
    fixedApp.use(express.json());
    fixedApp.use((req, _res, next) => {
      (req as unknown as Record<string, unknown>).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
      next();
    });
    fixedApp.use("/api", shiftsRouter); // shifts first (the fix)
    // Admin-only router mounted after
    const mockAdminRouter = express.Router();
    mockAdminRouter.use((_req, res, next) => {
      const user = (_req as unknown as Record<string, unknown>).dbUser as { role?: string } | undefined;
      const role = user?.role ?? "";
      if (role !== "admin" && role !== "global_admin") {
        res.status(403).json({ error: "Forbidden: admin only" });
        return;
      }
      next();
    });
    mockAdminRouter.get("/admin/settings", (_req, res) => res.json({ settings: {} }));
    fixedApp.use("/api", mockAdminRouter);

    // Shift route is now reachable (CSR user is approved, role passes)
    const shiftRes = await supertest(fixedApp).get("/api/shifts/current");
    expect(shiftRes.status).toBe(200);
    expect(shiftRes.body).toHaveProperty("shift", null);

    // Reset the mock counter so the second request gets a fresh user lookup
    configureDb({ user: makeUser("customer_service_rep", "approved") });

    // Admin route is still blocked for CSR even after router order fix
    const adminRes = await supertest(fixedApp).get("/api/admin/settings");
    expect(adminRes.status).toBe(403);
    expect(adminRes.body.error).toMatch(/admin only/i);
  });
});
