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
import multer from "multer";
import { assertTemporaryProfileImage, cleanupTemporaryProfileImages, finalizeProfileImage, readProfileImage, storeTemporaryProfileImage } from "../lib/profileImageStore";
import { z } from "zod/v4";

const router: IRouter = Router();
const profileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });
function receiveProfileUpload(req: Request, res: Response, next: (err?: unknown) => void) {
  profileUpload.single("file")(req, res, (err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "Profile image must be no larger than 3 MB." });
      return;
    }
    if (err) { res.status(400).json({ error: "Could not receive profile image. Choose one PNG, JPEG, or WebP file and retry." }); return; }
    next();
  });
}
const profileImageUploadBody = z.object({ profileImageUploadId: z.string().uuid() });

async function cleanupUploads() {
  const users = await db.select({ avatarUrl: usersTable.avatarUrl }).from(usersTable);
  const referenced = new Set(users.map(({ avatarUrl }) => avatarUrl?.match(/^\/api\/profile-images\/([0-9a-f-]{36})$/i)?.[1]).filter((id): id is string => !!id));
  await cleanupTemporaryProfileImages(referenced);
}
const imageCleanupTimer = setInterval(() => { void cleanupUploads().catch(() => undefined); }, 15 * 60 * 1000);
imageCleanupTimer.unref();

router.post("/profile-images", receiveProfileUpload, async (req, res): Promise<void> => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !req.file) {
    res.status(400).json({ error: "Email and a PNG, JPEG, or WebP profile image are required." });
    return;
  }
  try {
    const uploadId = await storeTemporaryProfileImage(req.file.buffer, req.file.mimetype, email);
    await cleanupUploads();
    res.status(201).json({ uploadId });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Profile image upload failed." });
  }
});

router.get("/profile-images/:id", async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const image = await readProfileImage(id);
  if (!image) { res.status(404).end(); return; }
  res.set({
    "Content-Type": "image/webp",
    "Content-Length": String(image.length),
    "Content-Disposition": "inline; filename=profile.webp",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "public, max-age=3600, immutable",
  }).send(image);
});

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
  const requestBody = SubmitOnboardingRequestBody.safeParse(req.body);
  const imageBody = profileImageUploadBody.safeParse(req.body);
  if (!requestBody.success) {
    res.status(400).json({ error: requestBody.error.message });
    return;
  }
  if (!imageBody.success) {
    res.status(400).json({ error: imageBody.error.message });
    return;
  }
  const body = { data: { ...requestBody.data, ...imageBody.data } };
  const { profileImageUploadId, ...requestData } = body.data;
  // The request is accepted only for the authenticated, Clerk-verified
  // identity resolved by loadDbUser. This avoids provisioning arbitrary email
  // addresses through the unauthenticated endpoint.
  const currentEmail = req.dbUser?.email?.trim().toLowerCase();
  if (!currentEmail || currentEmail !== body.data.contactEmail.trim().toLowerCase()) {
    res.status(403).json({ error: "Sign in with the verified email address to finish registration." });
    return;
  }
  const imagePath = `/api/profile-images/${profileImageUploadId}`;
  const previouslyLinked = req.dbUser?.avatarUrl === imagePath;
  if (!previouslyLinked) {
    try { await assertTemporaryProfileImage(profileImageUploadId, currentEmail); }
    catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : "Please upload your profile image again." }); return; }
  }
  await ensureAccessRequestUserSchema();
  const email = body.data.contactEmail.trim().toLowerCase();
  // Persist the same canonical identity used by the lock and lookup so case
  // variants of an address cannot create separate request rows.
  requestData.contactEmail = email;
  let finalizeImage = false;
  const row = await db.transaction(async (tx) => {
    // Serialize duplicate submits for the same normalized address. The lock is
    // transaction scoped, so failures roll back both request and placeholder.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(lower(${email}), 0))`);
    const [existingRequest] = await tx.select().from(onboardingRequestsTable)
      .where(sql`lower(${onboardingRequestsTable.contactEmail}) = lower(${email})`)
      .orderBy(desc(onboardingRequestsTable.createdAt)).limit(1);
    const [saved] = existingRequest
      ? [existingRequest]
      : await tx.insert(onboardingRequestsTable).values({ ...requestData, status: "submitted" }).returning();

    const [existingUser] = await tx.select({ id: usersTable.id, status: usersTable.status, avatarUrl: usersTable.avatarUrl })
      .from(usersTable).where(sql`lower(${usersTable.email}) = lower(${email})`).limit(1);
    if (!existingUser) {
      await tx.insert(usersTable).values({
        clerkId: `pending_request:${email.toLowerCase()}`, email,
        firstName: requestData.contactName, contactPhone: requestData.contactPhone ?? null,
        avatarUrl: imagePath, role: "user", status: "pending", isActive: true,
      });
      finalizeImage = true;
    } else if (existingUser.status === "pending") {
      // Do not downgrade, reactivate, or otherwise alter an approved/rejected
      // identity during retries. Provisioning only fills the pending profile.
      await tx.update(usersTable).set({
        firstName: requestData.contactName,
        contactPhone: requestData.contactPhone ?? null,
        ...(existingUser.avatarUrl ? {} : { avatarUrl: imagePath }),
      }).where(eq(usersTable.id, existingUser.id));
      finalizeImage = !existingUser.avatarUrl;
    } else if (existingUser.status === "approved") {
      // Existing approved members retain their profile image and access state.
    } else {
      throw new Error("This account cannot submit a registration request. Contact support.");
    }
    return saved;
  });

  if (finalizeImage || previouslyLinked) await finalizeProfileImage(profileImageUploadId);

  res.status(200).json(mapRequest(row));
}

// POST /api/onboarding/request — Clerk identity is reconciled before accepting
// a request. Pending approval remains unchanged by this endpoint.
router.post("/onboarding/request", requireAuth, loadDbUser, requireDbUser, submitOnboardingRequestHandler);

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
