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
    const { db, usersTable, tenantsTable, auditLogsTable, notificationsTable, catalogItemsTable, inventoryLocationsTable, inventoryBalancesTable, pool } = database;
    const { eq, and } = await import("drizzle-orm");
    // The migration rehearsal intentionally stops at the production 0067
    // boundary and therefore does not create later inventory objects. Build
    // only the current API runtime schema needed for these disposable tests,
    // from the corresponding Drizzle models and tenant-scoped constraints.
    await pool.query(`
      ALTER TABLE public.catalog_items
        ADD COLUMN IF NOT EXISTS sku text,
        ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'test',
        ADD COLUMN IF NOT EXISTS price numeric(10,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS alavont_name text,
        ADD COLUMN IF NOT EXISTS lucifer_cruz_name text,
        ADD COLUMN IF NOT EXISTS customer_safe_name text,
        ADD COLUMN IF NOT EXISTS alavont_category text,
        ADD COLUMN IF NOT EXISTS regular_price numeric(10,2),
        ADD COLUMN IF NOT EXISTS stock_unit text DEFAULT '#',
        ADD COLUMN IF NOT EXISTS stock_quantity numeric(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS is_woo_managed boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS is_local_alavont boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS moq numeric(10,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS preferred_reorder_quantity numeric(10,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cost_basis numeric(10,2);
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='p0_test_users_tenant_fk') THEN
          ALTER TABLE public.users ADD CONSTRAINT p0_test_users_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='p0_test_catalog_tenant_fk') THEN
          ALTER TABLE public.catalog_items ADD CONSTRAINT p0_test_catalog_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='p0_test_catalog_tenant_id_id_unique') THEN
          ALTER TABLE public.catalog_items ADD CONSTRAINT p0_test_catalog_tenant_id_id_unique UNIQUE (tenant_id, id);
        END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS public.admin_settings (
        id serial PRIMARY KEY, tenant_id integer NOT NULL UNIQUE REFERENCES public.tenants(id), petty_cash numeric(10,2) DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS public.role_permissions (
        id serial PRIMARY KEY, tenant_id integer REFERENCES public.tenants(id), role text NOT NULL,
        permission text NOT NULL, enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS role_permissions_tenant_role_permission_unique
        ON public.role_permissions(tenant_id, role, permission);
      CREATE TABLE IF NOT EXISTS public.csr_boxes (
        id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES public.tenants(id), slug text NOT NULL,
        label text NOT NULL, description text, location text, is_active boolean NOT NULL DEFAULT true,
        display_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id), UNIQUE (tenant_id, slug)
      );
      CREATE TABLE IF NOT EXISTS public.inventory_locations (
        id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES public.tenants(id), type text NOT NULL,
        csr_box_id integer REFERENCES public.csr_boxes(id), name text NOT NULL, is_active boolean NOT NULL DEFAULT true,
        display_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS public.inventory_balances (
        id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES public.tenants(id), product_id integer NOT NULL,
        location_id integer NOT NULL, quantity_on_hand numeric(20,6) NOT NULL DEFAULT 0,
        par_level numeric(20,6) NOT NULL DEFAULT 0, inventory_kind text NOT NULL DEFAULT 'sellable_catalog',
        is_sellable boolean NOT NULL DEFAULT true, quarantined_at timestamptz,
        quarantined_by_user_id integer REFERENCES public.users(id), quarantine_reason text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, product_id) REFERENCES public.catalog_items(tenant_id, id),
        FOREIGN KEY (tenant_id, location_id) REFERENCES public.inventory_locations(tenant_id, id),
        UNIQUE (tenant_id, product_id, location_id)
      );
      CREATE INDEX IF NOT EXISTS p0_test_inventory_balances_tenant_product_idx ON public.inventory_balances(tenant_id, product_id);
      CREATE INDEX IF NOT EXISTS p0_test_inventory_balances_tenant_location_idx ON public.inventory_balances(tenant_id, location_id);
    `);
    const [{ default: usersRouter }, { default: shiftsRouter }, { default: inventoryRouter }] = await Promise.all([
      import("../users"), import("../shifts"), import("../inventory"),
    ]);
    const { requireAuth, loadDbUser, requireDbUser, requireApproved } = await import("../../lib/auth");
    const [tenant] = await db.select({ id: tenantsTable.id }).from(tenantsTable).limit(1);
    if (!tenant) throw new Error("Disposable database needs one tenant");
    const [foreignTenant] = await db.insert(tenantsTable).values({ name: "P0 foreign fixture", slug: `p0-foreign-${process.pid}-${Date.now()}`, status: "active" }).returning({ id: tenantsTable.id });
    const owner = await db.insert(usersTable).values({ clerkId: ownerId, email: "owner@test.invalid", role: "global_admin", status: "approved", tenantId: tenant.id, isActive: true }).returning({ id: usersTable.id });
    const subjectId = `user_pg_hotfix_${process.pid}_${Date.now()}`;
    const subject = await db.insert(usersTable).values({ clerkId: subjectId, email: `${subjectId}@test.invalid`, role: "csr", status: "pending", tenantId: tenant.id, isActive: true }).returning({ id: usersTable.id });
    const supervisorId = `${subjectId}_supervisor`;
    const supervisor = await db.insert(usersTable).values({ clerkId: supervisorId, email: `${supervisorId}@test.invalid`, role: "supervisor", status: "approved", approvedByClerkId: ownerId, approvedAt: new Date(), tenantId: tenant.id, isActive: true }).returning({ id: usersTable.id });
    const adminId = `${subjectId}_admin`;
    const admin = await db.insert(usersTable).values({ clerkId: adminId, email: `${adminId}@test.invalid`, role: "admin", status: "approved", approvedByClerkId: ownerId, approvedAt: new Date(), tenantId: tenant.id, isActive: true }).returning({ id: usersTable.id });
    const decoyId = `${subjectId}_decoy`;
    const decoy = await db.insert(usersTable).values({ clerkId: decoyId, email: "owner@test.invalid", role: "global_admin", status: "approved", tenantId: tenant.id, isActive: true }).returning({ id: usersTable.id });
    const rollbackId = `${subjectId}_rollback`;
    const rollbackTarget = await db.insert(usersTable).values({ clerkId: rollbackId, email: `${rollbackId}@test.invalid`, role: "user", status: "pending", tenantId: tenant.id, isActive: true }).returning({ id: usersTable.id });
    const syncFailureId = `${subjectId}_sync_failure`;
    const syncFailureTarget = await db.insert(usersTable).values({ clerkId: syncFailureId, email: `${syncFailureId}@test.invalid`, role: "user", status: "pending", tenantId: tenant.id, isActive: true }).returning({ id: usersTable.id });
    const crossTenantId = `${subjectId}_cross_tenant`;
    const crossTenantTarget = await db.insert(usersTable).values({ clerkId: crossTenantId, email: `${crossTenantId}@test.invalid`, role: "user", status: "pending", tenantId: foreignTenant.id, isActive: true }).returning({ id: usersTable.id });
    const ownProduct = (await pool.query(`INSERT INTO public.catalog_items(tenant_id,name,category,sku,price,is_available,metadata) VALUES ($1,'P0 own fixture product','test','P0-OWN',1,true,'{}') RETURNING id`, [tenant.id])).rows[0] as { id: number };
    const foreignProduct = (await pool.query(`INSERT INTO public.catalog_items(tenant_id,name,category,sku,price,is_available,metadata) VALUES ($1,'P0 foreign fixture product','test','P0-FOREIGN',1,true,'{}') RETURNING id`, [foreignTenant.id])).rows[0] as { id: number };
    const [ownLocationOne] = await db.insert(inventoryLocationsTable).values({ tenantId: tenant.id, type: "backstock", name: "P0 location one" }).returning({ id: inventoryLocationsTable.id });
    const [ownLocationTwo] = await db.insert(inventoryLocationsTable).values({ tenantId: tenant.id, type: "storefront", name: "P0 location two" }).returning({ id: inventoryLocationsTable.id });
    const [foreignLocation] = await db.insert(inventoryLocationsTable).values({ tenantId: foreignTenant.id, type: "backstock", name: "P0 foreign location" }).returning({ id: inventoryLocationsTable.id });
    await db.insert(inventoryBalancesTable).values([
      { tenantId: tenant.id, productId: ownProduct.id, locationId: ownLocationOne.id, quantityOnHand: "4" },
      { tenantId: tenant.id, productId: ownProduct.id, locationId: ownLocationTwo.id, quantityOnHand: "7" },
      { tenantId: foreignTenant.id, productId: foreignProduct.id, locationId: foreignLocation.id, quantityOnHand: "9" },
    ]);
    const app = express(); app.use(express.json()); app.use("/api", usersRouter);
    const shiftApp = express(); shiftApp.use(express.json()); shiftApp.use("/api", shiftsRouter);
    const inventoryApp = express(); inventoryApp.use(express.json()); inventoryApp.use("/api", inventoryRouter);
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
      expect((await supertest(inventoryApp).get("/api/admin/inventory")).status).toBe(403);
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
      const ownerInventory = await supertest(inventoryApp).get("/api/admin/inventory");
      expect(ownerInventory.status, JSON.stringify(ownerInventory.body)).toBe(200);
      expect(ownerInventory.body.items.map((item: { id: number }) => item.id)).toContain(ownProduct.id);
      expect(ownerInventory.body.items.map((item: { id: number }) => item.id)).not.toContain(foreignProduct.id);
      expect(ownerInventory.body.locations.map((location: { id: number }) => location.id)).not.toContain(foreignLocation.id);
      expect((await supertest(app).get("/api/users/me")).body.isConfiguredOwner).toBe(true);
      await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, owner[0].id));
      expect((await supertest(protectedApp).get("/api/protected-fixture")).status).toBe(403);
      await db.update(usersTable).set({ isActive: true }).where(eq(usersTable.id, owner[0].id));
      await db.update(usersTable).set({ status: "pending" }).where(eq(usersTable.id, owner[0].id));
      expect((await supertest(protectedApp).get("/api/protected-fixture")).status).toBe(403);
      expect((await supertest(shiftApp).get("/api/shift-queue/status")).status).toBe(403);
      const pendingOwnerMutation = await supertest(app).patch(`/api/admin/users/${rollbackTarget[0].id}/approval`).send({ approve: true, tenantId: tenant.id });
      expect(pendingOwnerMutation.status).toBe(403);
      expect(pendingOwnerMutation.body.code).toBe("ACCOUNT_PENDING_APPROVAL");
      await db.update(usersTable).set({ status: "approved" }).where(eq(usersTable.id, owner[0].id));

      clerkState.userId = subjectId;
      await db.update(usersTable).set({ status: "approved", approvedByClerkId: "some_other_owner", approvedAt: new Date() }).where(eq(usersTable.id, subject[0].id));
      expect((await supertest(app).get("/api/users")).status).toBe(403);
      expect((await supertest(shiftApp).get("/api/shifts/current")).status).toBe(403);
      clerkState.userId = decoyId;
      expect((await supertest(protectedApp).get("/api/protected-fixture")).status).toBe(403);
      clerkState.userId = adminId;
      expect((await supertest(inventoryApp).get(`/api/admin/inventory?tenantId=${foreignTenant.id}`)).status).toBe(403);
      const locationOne = await supertest(shiftApp).get(`/api/admin/inventory-balances?locationId=${ownLocationOne.id}`);
      const locationTwo = await supertest(shiftApp).get(`/api/admin/inventory-balances?locationId=${ownLocationTwo.id}`);
      const foreignLocationQuery = await supertest(shiftApp).get(`/api/admin/inventory-balances?locationId=${foreignLocation.id}`);
      expect(locationOne.status).toBe(200);
      expect(locationOne.body.balances.map((balance: { locationId: number }) => balance.locationId)).toEqual([ownLocationOne.id]);
      expect(locationTwo.body.balances.map((balance: { locationId: number }) => balance.locationId)).toEqual([ownLocationTwo.id]);
      expect(foreignLocationQuery.body.balances).toEqual([]);
      expect(foreignLocationQuery.body.locations.map((location: { id: number }) => location.id)).not.toContain(foreignLocation.id);
      clerkState.userId = supervisorId;
      const deniedInventoryEdit = await supertest(inventoryApp).patch(`/api/admin/inventory/${ownProduct.id}`).send({ stockUnit: "unauthorized" });
      expect(deniedInventoryEdit.status).toBe(403);
      const inventoryAfterDeniedEdit = (await pool.query("SELECT stock_unit FROM public.catalog_items WHERE id=$1", [ownProduct.id])).rows[0] as { stock_unit: string | null };
      expect(inventoryAfterDeniedEdit.stock_unit).not.toBe("unauthorized");

      clerkState.userId = ownerId;
      clerkState.sessionClaims = { fva: [11, -1] };
      const expiredAuth = await supertest(app).patch(`/api/admin/users/${subject[0].id}/approval`).send({ approve: true, tenantId: tenant.id });
      expect(expiredAuth.status).toBe(403);
      expect(expiredAuth.body.code).toBe("RECENT_AUTH_REQUIRED");
      clerkState.sessionClaims = { fva: [1, -1] };
      const result = await supertest(app).patch(`/api/admin/users/${subject[0].id}/approval`).send({ approve: true, role: "csr", tenantId: tenant.id });
      expect(result.status).toBe(200);
      const legacyApproval = await supertest(app).patch(`/api/users/${rollbackTarget[0].id}/status`).send({ status: "approved" });
      expect(legacyApproval.status).toBe(400);
      expect(legacyApproval.body.code).toBe("USE_OWNER_APPROVAL_ENDPOINT");
      const [legacyTarget] = await db.select().from(usersTable).where(eq(usersTable.id, rollbackTarget[0].id));
      expect(legacyTarget).toMatchObject({ status: "pending", approvedByClerkId: null, approvedAt: null });
      const [approved] = await db.select().from(usersTable).where(eq(usersTable.id, subject[0].id));
      expect(approved).toMatchObject({ status: "approved", approvedByClerkId: ownerId, tenantId: tenant.id });
      expect(approved.approvedAt).toBeInstanceOf(Date);
      const repeat = await supertest(app).patch(`/api/admin/users/${subject[0].id}/approval`).send({ approve: true, role: "csr", tenantId: tenant.id });
      expect(repeat.status).toBe(200);
      const [afterRepeat] = await db.select().from(usersTable).where(eq(usersTable.id, subject[0].id));
      expect(afterRepeat.approvedAt).toEqual(approved.approvedAt);
      const approvalAudit = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.actorId, owner[0].id), eq(auditLogsTable.resourceId, String(subject[0].id))));
      expect(approvalAudit.filter((row) => row.action === "APPROVE_USER")).toHaveLength(1);
      expect(approvalAudit).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "APPROVE_USER", actorId: owner[0].id, resourceType: "user", resourceId: String(subject[0].id) }),
      ]));

      // Global administrators have platform-wide authority. Their approval
      // audit records the destination tenant, and replay is idempotent.
      const crossTenantApproval = await supertest(app).patch(`/api/admin/users/${crossTenantTarget[0].id}/approval`).send({ approve: true, role: "user", tenantId: foreignTenant.id });
      expect(crossTenantApproval.status).toBe(200);
      const [crossTenantApproved] = await db.select().from(usersTable).where(eq(usersTable.id, crossTenantTarget[0].id));
      expect(crossTenantApproved).toMatchObject({ status: "approved", approvedByClerkId: ownerId, tenantId: foreignTenant.id });
      expect(crossTenantApproved.approvedAt).toBeInstanceOf(Date);
      const crossTenantReplay = await supertest(app).patch(`/api/admin/users/${crossTenantTarget[0].id}/approval`).send({ approve: true, role: "user", tenantId: foreignTenant.id });
      expect(crossTenantReplay.status).toBe(200);
      const [crossTenantAfterReplay] = await db.select().from(usersTable).where(eq(usersTable.id, crossTenantTarget[0].id));
      expect(crossTenantAfterReplay.approvedAt).toEqual(crossTenantApproved.approvedAt);
      const crossTenantAudit = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.actorId, owner[0].id), eq(auditLogsTable.resourceId, String(crossTenantTarget[0].id))));
      expect(crossTenantAudit.filter((row) => row.action === "APPROVE_USER")).toHaveLength(1);
      expect(crossTenantAudit[0]).toMatchObject({ tenantId: foreignTenant.id, action: "APPROVE_USER" });

      const selfApproval = await supertest(app).patch(`/api/admin/users/${owner[0].id}/approval`).send({ approve: true, tenantId: tenant.id });
      expect(selfApproval.status).toBe(404);
      expect(selfApproval.body.code).toBe("APPROVAL_TARGET_UNAVAILABLE");
      const [ownerAfterSelfApproval] = await db.select().from(usersTable).where(eq(usersTable.id, owner[0].id));
      expect(ownerAfterSelfApproval).toMatchObject({ status: "approved", approvedByClerkId: null, approvedAt: null });
      expect(await db.select().from(auditLogsTable).where(eq(auditLogsTable.resourceId, String(owner[0].id)))).toHaveLength(0);

      // The same route enforces destination scope for tenant administrators,
      // even when the caller supplies another valid tenant ID.
      process.env.MYORDER_OWNER_CLERK_ID = adminId;
      clerkState.userId = adminId;
      clerkState.sessionClaims = { fva: [1, -1] };
      const scopedTransfer = await supertest(app).patch(`/api/admin/users/${rollbackTarget[0].id}/approval`).send({ approve: true, tenantId: foreignTenant.id });
      expect(scopedTransfer.status).toBe(403);
      expect(scopedTransfer.body.code).toBe("TENANT_SCOPE_REQUIRED");
      const scopedForeignTarget = await supertest(app).patch(`/api/admin/users/${crossTenantTarget[0].id}/approval`).send({ approve: true, tenantId: foreignTenant.id });
      expect(scopedForeignTarget.status).toBe(404);
      expect(scopedForeignTarget.body.code).toBe("APPROVAL_TARGET_UNAVAILABLE");
      const [untransferred] = await db.select().from(usersTable).where(eq(usersTable.id, rollbackTarget[0].id));
      expect(untransferred).toMatchObject({ status: "pending", tenantId: tenant.id, approvedByClerkId: null, approvedAt: null });
      expect(await db.select().from(auditLogsTable).where(eq(auditLogsTable.resourceId, String(rollbackTarget[0].id)))).toHaveLength(0);
      process.env.MYORDER_OWNER_CLERK_ID = ownerId;
      clerkState.userId = ownerId;

      const invalidTenant = await supertest(app).patch(`/api/admin/users/${rollbackTarget[0].id}/approval`).send({ approve: true, tenantId: 2147483647 });
      expect(invalidTenant.status).toBe(404);
      expect(invalidTenant.body.code).toBe("APPROVAL_TENANT_UNAVAILABLE");
      const [invalidTenantTarget] = await db.select().from(usersTable).where(eq(usersTable.id, rollbackTarget[0].id));
      expect(invalidTenantTarget).toMatchObject({ status: "pending", tenantId: tenant.id, approvedByClerkId: null, approvedAt: null });
      expect(await db.select().from(auditLogsTable).where(eq(auditLogsTable.resourceId, String(rollbackTarget[0].id)))).toHaveLength(0);

      // Simulate the supported Clerk re-verification path: only the request
      // retried with fresh server-verified claims reaches persistence.
      expect(result.status).toBe(200);
      const { clerkClient } = await import("@clerk/express");
      vi.mocked(clerkClient.users.updateUserMetadata).mockRejectedValueOnce(new Error("synthetic Clerk metadata outage"));
      const syncFailure = await supertest(app).patch(`/api/admin/users/${syncFailureTarget[0].id}/approval`).send({ approve: true, role: "user", tenantId: tenant.id });
      expect(syncFailure.status).toBe(200);
      const [syncFailureRow] = await db.select().from(usersTable).where(eq(usersTable.id, syncFailureTarget[0].id));
      expect(syncFailureRow).toMatchObject({ status: "approved", approvedByClerkId: ownerId, tenantId: tenant.id });
      expect(syncFailureRow.approvedAt).toBeInstanceOf(Date);
      const syncFailureAudit = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.actorId, owner[0].id), eq(auditLogsTable.resourceId, String(syncFailureTarget[0].id))));
      expect(syncFailureAudit.filter((row) => row.action === "APPROVE_USER")).toHaveLength(1);
      await pool.query(`
        CREATE OR REPLACE FUNCTION public.p0_test_reject_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'APPROVE_USER' AND NEW.resource_id = '${rollbackTarget[0].id}' THEN
            RAISE EXCEPTION 'synthetic approval audit failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER p0_test_reject_approval_audit BEFORE INSERT ON public.audit_logs
          FOR EACH ROW EXECUTE FUNCTION public.p0_test_reject_approval_audit();
      `);
      const rollbackResponse = await supertest(app).patch(`/api/admin/users/${rollbackTarget[0].id}/approval`).send({ approve: true, role: "user", tenantId: tenant.id });
      expect(rollbackResponse.status).toBe(500);
      expect(rollbackResponse.body.code).toBe("APPROVAL_PERSISTENCE_FAILED");
      const [rolledBack] = await db.select().from(usersTable).where(eq(usersTable.id, rollbackTarget[0].id));
      expect(rolledBack).toMatchObject({ status: "pending", approvedByClerkId: null, approvedAt: null });
      expect(await db.select().from(auditLogsTable).where(eq(auditLogsTable.resourceId, String(rollbackTarget[0].id)))).toHaveLength(0);
      await pool.query("DROP TRIGGER p0_test_reject_approval_audit ON public.audit_logs; DROP FUNCTION public.p0_test_reject_approval_audit();");
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
      await db.delete(auditLogsTable).where(eq(auditLogsTable.resourceId, String(syncFailureTarget[0].id)));
      await db.delete(auditLogsTable).where(eq(auditLogsTable.resourceId, String(rollbackTarget[0].id)));
      await db.delete(auditLogsTable).where(eq(auditLogsTable.resourceId, String(crossTenantTarget[0].id)));
      await db.delete(notificationsTable).where(eq(notificationsTable.userId, syncFailureTarget[0].id));
      await db.delete(notificationsTable).where(eq(notificationsTable.userId, crossTenantTarget[0].id));
      await db.delete(inventoryBalancesTable).where(eq(inventoryBalancesTable.productId, ownProduct.id));
      await db.delete(inventoryBalancesTable).where(eq(inventoryBalancesTable.productId, foreignProduct.id));
      await pool.query("DELETE FROM public.catalogue_options WHERE (tenant_id, inventory_item_id) IN (SELECT tenant_id, id FROM public.inventory_items WHERE (tenant_id, catalog_item_id) IN (($1, $2), ($3, $4)))", [tenant.id, ownProduct.id, foreignTenant.id, foreignProduct.id]);
      await pool.query("DELETE FROM public.inventory_items WHERE (tenant_id, catalog_item_id) IN (($1, $2), ($3, $4))", [tenant.id, ownProduct.id, foreignTenant.id, foreignProduct.id]);
      await pool.query("DELETE FROM public.catalogue_options WHERE (tenant_id, catalog_item_id) IN (($1, $2), ($3, $4))", [tenant.id, ownProduct.id, foreignTenant.id, foreignProduct.id]);
      await db.delete(catalogItemsTable).where(eq(catalogItemsTable.id, ownProduct.id));
      await db.delete(catalogItemsTable).where(eq(catalogItemsTable.id, foreignProduct.id));
      await db.delete(inventoryLocationsTable).where(eq(inventoryLocationsTable.id, ownLocationOne.id));
      await db.delete(inventoryLocationsTable).where(eq(inventoryLocationsTable.id, ownLocationTwo.id));
      await db.delete(inventoryLocationsTable).where(eq(inventoryLocationsTable.id, foreignLocation.id));
      await db.delete(usersTable).where(eq(usersTable.id, decoy[0].id));
      await db.delete(usersTable).where(eq(usersTable.id, rollbackTarget[0].id));
      await db.delete(usersTable).where(eq(usersTable.id, syncFailureTarget[0].id));
      await db.delete(usersTable).where(eq(usersTable.id, crossTenantTarget[0].id));
      await db.delete(usersTable).where(eq(usersTable.id, supervisor[0].id));
      await db.delete(usersTable).where(eq(usersTable.id, admin[0].id));
      await db.delete(usersTable).where(eq(usersTable.id, subject[0].id));
      await db.delete(usersTable).where(eq(usersTable.id, owner[0].id));
      await pool.query("DELETE FROM public.catalogue_products WHERE (tenant_id, name) IN (($1, $2), ($3, $4))", [tenant.id, "P0 own fixture product", foreignTenant.id, "P0 foreign fixture product"]);
      await db.delete(tenantsTable).where(eq(tenantsTable.id, foreignTenant.id));
      await pool.end();
    }
  }, 30000);
});
