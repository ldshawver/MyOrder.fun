import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { db, onboardingRequestsTable, tenantsTable, usersTable, auditLogsTable } from "@workspace/db";
import {
  SubmitOnboardingRequestBody,
  ListOnboardingRequestsQueryParams,
  ListOnboardingRequestsResponse,
  GetOnboardingRequestParams,
  GetOnboardingRequestResponse,
  UpdateOnboardingRequestParams,
  UpdateOnboardingRequestBody,
  UpdateOnboardingRequestResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireApproved, requireRecentOwnerAuth, requireDbUser } from "../lib/auth";
import { requirePermission } from "../lib/roles";

const router: IRouter = Router();

async function ensureAccessRequestUserSchema(): Promise<void> {
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "contact_phone" text`);
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'pending'`);
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true`);
}

function mapRequest(r: typeof onboardingRequestsTable.$inferSelect) {
  return {
    id: r.id,
    companyName: r.companyName,
    contactName: r.contactName,
    contactEmail: r.contactEmail,
    contactPhone: r.contactPhone ?? undefined,
    businessType: r.businessType,
    website: r.website ?? undefined,
    description: r.description ?? undefined,
    expectedOrderVolume: r.expectedOrderVolume ?? undefined,
    status: r.status,
    reviewNotes: r.reviewNotes ?? undefined,
    reviewedBy: r.reviewedBy ?? undefined,
    tenantId: r.tenantId ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function submitOnboardingRequestHandler(req: Request, res: Response): Promise<void> {
  const body = SubmitOnboardingRequestBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  await ensureAccessRequestUserSchema();
  const [row] = await db.insert(onboardingRequestsTable).values({
    ...body.data,
    status: "submitted",
  }).returning();

  const email = body.data.contactEmail.trim();
  const [existingUser] = await db
    .select({ id: usersTable.id, status: usersTable.status })
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = lower(${email})`)
    .limit(1);

  if (!existingUser) {
    await db.insert(usersTable).values({
      clerkId: `pending_request:${email.toLowerCase()}`,
      email,
      firstName: body.data.contactName,
      contactPhone: body.data.contactPhone ?? null,
      role: "user",
      status: "pending",
      isActive: true,
    });
  } else if (existingUser.status !== "approved") {
    await db.update(usersTable)
      .set({
        firstName: body.data.contactName,
        contactPhone: body.data.contactPhone ?? null,
        status: "pending",
        isActive: true,
      })
      .where(eq(usersTable.id, existingUser.id));
  }

  res.status(201).json(mapRequest(row));
}

// POST /api/onboarding/request — public, no auth required
router.post("/onboarding/request", submitOnboardingRequestHandler);

// GET /api/onboarding/requests — global admin only
router.get("/onboarding/requests", requireAuth, loadDbUser, requireDbUser, requireApproved, requirePermission("platform.tenants.view"), async (req, res): Promise<void> => {
  const query = ListOnboardingRequestsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  let rows = await db.select().from(onboardingRequestsTable).orderBy(desc(onboardingRequestsTable.createdAt));
  if (query.data.status) {
    rows = rows.filter(r => r.status === query.data.status);
  }

  const page = query.data.page ?? 1;
  const limit = query.data.limit ?? 20;
  const offset = (page - 1) * limit;
  const total = rows.length;
  const paged = rows.slice(offset, offset + limit);

  const data = ListOnboardingRequestsResponse.parse({
    requests: paged.map(mapRequest),
    total,
    page,
    limit,
  });
  res.json(data);
});

// GET /api/onboarding/requests/:id — global admin only
router.get("/onboarding/requests/:id", requireAuth, loadDbUser, requireDbUser, requireApproved, requirePermission("platform.tenants.view"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetOnboardingRequestParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.select().from(onboardingRequestsTable).where(eq(onboardingRequestsTable.id, params.data.id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(GetOnboardingRequestResponse.parse(mapRequest(row)));
});

// PATCH /api/onboarding/requests/:id — global admin only
router.patch("/onboarding/requests/:id", requireAuth, loadDbUser, requireDbUser, requireApproved, requirePermission("platform.tenants.manage"), requireRecentOwnerAuth, async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateOnboardingRequestParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateOnboardingRequestBody.strict().safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(onboardingRequestsTable).where(eq(onboardingRequestsTable.id, params.data.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const updateValues: Partial<typeof onboardingRequestsTable.$inferInsert> = {
    reviewedBy: actor.id,
  };
  if (body.data.status) updateValues.status = body.data.status;
  if (body.data.reviewNotes != null) updateValues.reviewNotes = body.data.reviewNotes;

  // This approves the tenant application only. Account status, role, tenant
  // membership, and P0 approval provenance remain exclusively in the owner
  // approval flow in routes/users.ts.
  let createdTenantId: number | null = null;
  const updated = await db.transaction(async (tx) => {
    if (body.data.status === "approved" && !existing.tenantId) {
      const slug = existing.companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const [tenant] = await tx.insert(tenantsTable).values({
        name: existing.companyName,
        slug: `${slug}-${Date.now()}`,
        status: "active",
        contactEmail: existing.contactEmail,
      }).returning();
      createdTenantId = tenant.id;
      updateValues.tenantId = tenant.id;
    }

    const [saved] = await tx.update(onboardingRequestsTable)
      .set(updateValues)
      .where(eq(onboardingRequestsTable.id, params.data.id))
      .returning();
    if (!saved) throw new Error("Onboarding request changed during update");

    await tx.insert(auditLogsTable).values({
      actorId: actor.id,
      actorEmail: actor.email ?? "",
      actorRole: actor.role,
      action: "UPDATE_ONBOARDING_REQUEST",
      tenantId: null,
      resourceType: "onboarding_request",
      resourceId: String(params.data.id),
      metadata: { scope: "platform", newStatus: body.data.status, previousStatus: existing.status, createdTenantId },
      ipAddress: req.ip ?? null,
    });
    return saved;
  });

  res.json(UpdateOnboardingRequestResponse.parse(mapRequest(updated)));
});

export default router;
