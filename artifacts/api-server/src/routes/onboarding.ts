import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, onboardingRequestsTable, tenantsTable, usersTable } from "@workspace/db";
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
import { requireAuth, loadDbUser, requireRole, requireDbUser, writeAuditLog } from "../lib/auth";

const router: IRouter = Router();

function mapRequest(r: typeof onboardingRequestsTable.$inferSelect) {
  return {
    id: r.id,
    companyName: r.companyName,
    contactName: r.contactName,
    contactEmail: r.contactEmail,
    contactPhone: r.contactPhone,
    businessType: r.businessType,
    website: r.website,
    description: r.description,
    expectedOrderVolume: r.expectedOrderVolume,
    status: r.status,
    reviewNotes: r.reviewNotes,
    reviewedBy: r.reviewedBy,
    tenantId: r.tenantId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// POST /api/onboarding/request — public, no auth required
router.post("/onboarding/request", async (req, res): Promise<void> => {
  const body = SubmitOnboardingRequestBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [row] = await db.insert(onboardingRequestsTable).values({
    ...body.data,
    status: "submitted",
  }).returning();

  res.status(201).json(mapRequest(row));
});

// GET /api/onboarding/requests — global admin only
router.get("/onboarding/requests", requireAuth, loadDbUser, requireDbUser, requireRole("global_admin"), async (req, res): Promise<void> => {
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
router.get("/onboarding/requests/:id", requireAuth, loadDbUser, requireDbUser, requireRole("global_admin"), async (req, res): Promise<void> => {
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
router.patch("/onboarding/requests/:id", requireAuth, loadDbUser, requireDbUser, requireRole("global_admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateOnboardingRequestParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateOnboardingRequestBody.safeParse(req.body);
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

  // If approved, provision tenant and update status
  if (body.data.status === "approved" && !existing.tenantId) {
    const slug = existing.companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const [tenant] = await db.insert(tenantsTable).values({
      name: existing.companyName,
      slug: `${slug}-${Date.now()}`,
      status: "active",
      contactEmail: existing.contactEmail,
    }).returning();
    updateValues.tenantId = tenant.id;
  }

  const [updated] = await db.update(onboardingRequestsTable)
    .set(updateValues)
    .where(eq(onboardingRequestsTable.id, params.data.id))
    .returning();

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "UPDATE_ONBOARDING_REQUEST",
    resourceType: "onboarding_request",
    resourceId: String(params.data.id),
    metadata: { newStatus: body.data.status, previousStatus: existing.status },
    ipAddress: req.ip,
  });

  res.json(UpdateOnboardingRequestResponse.parse(mapRequest(updated)));
});

export default router;
