/**
 * Feedback & Bug Reporting routes.
 *
 * RBAC summary:
 *   - Any authenticated, approved user can POST a new ticket.
 *   - Regular users can only list/view/comment on tickets THEY submitted.
 *     The DB query filters by submitterId — there is no client-supplied
 *     filter that bypasses this.
 *   - Admins/global admins can list/view/update/comment on every ticket.
 *
 * Tenant isolation: this deploy is single-tenant (house tenant id=1) so
 * the tenantId column is captured for forward compat but no per-tenant
 * filter is enforced beyond "regular users only see their own". A
 * `tenantId` filter param is honoured for admins.
 *
 * Notifications: in-app only, written into the existing notifications
 * table (no email dependency). Submitter is notified on status change;
 * every admin/global admin is notified on new ticket creation.
 */
import { Router, type IRouter } from "express";
import { eq, and, desc, gte, lte, inArray, lt } from "drizzle-orm";
import {
  db,
  feedbackTicketsTable,
  feedbackTicketCommentsTable,
  notificationsTable,
  usersTable,
  adminSettingsTable,
} from "@workspace/db";
import { z } from "zod/v4";
import {
  requireAuth,
  loadDbUser,
  requireDbUser,
  requireApproved,
  writeAuditLog,
  normalizeRole,
} from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const ADMIN_VIEW_ROLES = ["global_admin", "admin", "supervisor"] as const;
const ADMIN_WRITE_ROLES = ["global_admin", "admin", "supervisor"] as const;

const FEEDBACK_TYPES = ["bug", "ux", "feature", "general"] as const;
const FEEDBACK_SEVERITIES = ["low", "medium", "high", "critical"] as const;
const FEEDBACK_STATUSES = [
  "submitted",
  "reviewed",
  "in_progress",
  "implemented",
  "rejected",
  "closed",
  "needs_more_info",
] as const;

// 2 MB cap on inline base64 screenshots. Anything bigger and the user
// should be using a dedicated upload service — out of scope for v1.
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

const CreateTicketBody = z
  .object({
    type: z.enum(FEEDBACK_TYPES),
    severity: z.enum(FEEDBACK_SEVERITIES).default("medium"),
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(5).max(5000),
    pageUrl: z.string().trim().max(1000).nullable().optional(),
    userAgent: z.string().trim().max(1024).nullable().optional(),
    screenshotData: z
      .string()
      .max(MAX_SCREENSHOT_BYTES * 2)
      .nullable()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.metadata !== undefined &&
      Buffer.byteLength(JSON.stringify(value.metadata), "utf8") > 8192
    ) {
      ctx.addIssue({
        code: "custom",
        message: "metadata exceeds 8KB limit",
        path: ["metadata"],
      });
    }
  });

const UpdateTicketBody = z
  .object({
    status: z.enum(FEEDBACK_STATUSES).optional(),
    priority: z.boolean().optional(),
    assigneeId: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.status !== undefined ||
      v.priority !== undefined ||
      v.assigneeId !== undefined,
    { message: "At least one of status, priority, assigneeId is required" },
  );

const ListQueryParams = z
  .object({
    tenantId: z.coerce.number().int().positive().optional(),
    type: z.enum(FEEDBACK_TYPES).optional(),
    status: z.enum(FEEDBACK_STATUSES).optional(),
    priority: z
      .union([z.boolean(), z.literal("true"), z.literal("false")])
      .transform((v) => v === true || v === "true")
      .optional(),
    assigneeId: z.coerce.number().int().positive().optional(),
    dateFrom: z.string().datetime().optional(),
    dateTo: z.string().datetime().optional(),
    mine: z.union([z.literal("true"), z.literal("false")]).optional(),
  })
  .strict();

const AddCommentBody = z
  .object({
    body: z.string().trim().min(1).max(5000),
    isInternal: z.boolean().optional().default(false),
  })
  .strict();

function normalizeFeedbackRole(role: string): string {
  const raw = role
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (raw === "admin") return "admin";
  if (raw === "supervisor") return "supervisor";
  return normalizeRole(raw);
}
function isAdminViewer(role: string): boolean {
  return (ADMIN_VIEW_ROLES as readonly string[]).includes(
    normalizeFeedbackRole(role),
  );
}
function isAdminWriter(role: string): boolean {
  return (ADMIN_WRITE_ROLES as readonly string[]).includes(
    normalizeFeedbackRole(role),
  );
}
const submitBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimitFeedback(
  req: Parameters<import("express").RequestHandler>[0],
  res: Parameters<import("express").RequestHandler>[1],
  next: Parameters<import("express").RequestHandler>[2],
): void {
  const actor = req.dbUser;
  const key = actor ? `user:${actor.id}` : `ip:${req.ip}`;
  const now = Date.now();
  const bucket = submitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    submitBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    next();
    return;
  }
  if (bucket.count >= 10) {
    res.status(429).json({
      error: "Too many feedback submissions. Please try again later.",
    });
    return;
  }
  bucket.count += 1;
  next();
}
function getRouteParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
function tenantScopedConditions(
  actor: NonNullable<import("express").Request["dbUser"]>,
  id?: number,
) {
  const conditions = id == null ? [] : [eq(feedbackTicketsTable.id, id)];
  if (
    normalizeFeedbackRole(actor.role) !== "global_admin" &&
    actor.tenantId != null
  ) {
    conditions.push(eq(feedbackTicketsTable.tenantId, actor.tenantId));
  }
  return conditions;
}

type FeedbackArchivePolicy = {
  archiveReviewedAfterDays: number | null;
  archiveUnreadAfterDays: number | null;
  archiveUnreadEnabled: boolean;
};

function positiveDayOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    return null;
  return value;
}

async function loadFeedbackArchivePolicy(): Promise<FeedbackArchivePolicy> {
  const [settings] = await db.select().from(adminSettingsTable).limit(1);
  return {
    archiveReviewedAfterDays: positiveDayOrNull(
      settings?.feedbackArchiveReviewedAfterDays,
    ),
    archiveUnreadAfterDays: positiveDayOrNull(
      settings?.feedbackArchiveUnreadAfterDays,
    ),
    archiveUnreadEnabled: settings?.feedbackArchiveUnreadEnabled === true,
  };
}

export async function runFeedbackAutoArchive(
  actor: { id: number; email: string | null; role: string } | null,
  ipAddress?: string,
): Promise<{ archivedReviewed: number; archivedUnread: number }> {
  const policy = await loadFeedbackArchivePolicy();
  const now = new Date();
  let archivedReviewed = 0;
  let archivedUnread = 0;

  if (policy.archiveReviewedAfterDays !== null) {
    const cutoff = new Date(
      now.getTime() - policy.archiveReviewedAfterDays * 24 * 60 * 60 * 1000,
    );
    const rows = await db
      .update(feedbackTicketsTable)
      .set({ status: "closed", archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(feedbackTicketsTable.status, "reviewed"),
          lt(feedbackTicketsTable.updatedAt, cutoff),
        ),
      )
      .returning();
    archivedReviewed = rows.length;
    if (rows.length > 0) {
      await writeAuditLog({
        actorId: actor?.id ?? 0,
        actorEmail: actor?.email ?? null,
        actorRole: actor?.role ?? "system",
        action: "feedback.auto_archive.reviewed",
        resourceType: "feedback_ticket",
        metadata: { count: rows.length, cutoff: cutoff.toISOString() },
        ipAddress,
      });
    }
  }

  if (policy.archiveUnreadEnabled && policy.archiveUnreadAfterDays !== null) {
    const cutoff = new Date(
      now.getTime() - policy.archiveUnreadAfterDays * 24 * 60 * 60 * 1000,
    );
    const rows = await db
      .update(feedbackTicketsTable)
      .set({ status: "closed", archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(feedbackTicketsTable.status, "submitted"),
          lt(feedbackTicketsTable.updatedAt, cutoff),
        ),
      )
      .returning();
    archivedUnread = rows.length;
    if (rows.length > 0) {
      await writeAuditLog({
        actorId: actor?.id ?? 0,
        actorEmail: actor?.email ?? null,
        actorRole: actor?.role ?? "system",
        action: "feedback.auto_archive.unread",
        resourceType: "feedback_ticket",
        metadata: { count: rows.length, cutoff: cutoff.toISOString() },
        ipAddress,
      });
    }
  }

  return { archivedReviewed, archivedUnread };
}

// ─── POST /api/feedback ──────────────────────────────────────────────────────
router.post("/feedback", rateLimitFeedback, async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const parsed = CreateTicketBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Reject oversized screenshots cleanly instead of letting Postgres choke.
  if (
    parsed.data.screenshotData &&
    parsed.data.screenshotData.length > MAX_SCREENSHOT_BYTES * 2
  ) {
    res.status(413).json({ error: "Screenshot exceeds 2MB limit" });
    return;
  }

  // Defence-in-depth against data-URI XSS: only allow real raster image
  // data URLs. Without this an attacker could submit `javascript:alert(1)`
  // (or a crafted `data:image/svg+xml,<script>…`) which would fire when an
  // admin clicked the screenshot link in the dashboard.
  if (parsed.data.screenshotData) {
    const ok = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(
      parsed.data.screenshotData,
    );
    if (!ok) {
      res.status(400).json({
        error: "Screenshot must be a base64 PNG/JPEG/GIF/WebP data URL",
      });
      return;
    }
  }

  const tenantId =
    actor.tenantId ?? (await getHouseTenantId().catch(() => null));

  const [created] = await db
    .insert(feedbackTicketsTable)
    .values({
      tenantId,
      submitterId: actor.id,
      submitterRole: normalizeFeedbackRole(actor.role),
      type: parsed.data.type,
      severity: parsed.data.severity,
      status: "submitted",
      priority: false,
      title: parsed.data.title,
      description: parsed.data.description,
      pageUrl: parsed.data.pageUrl ?? null,
      userAgent: parsed.data.userAgent ?? null,
      contextJson: parsed.data.metadata ?? null,
      screenshotData: parsed.data.screenshotData ?? null,
    })
    .returning();

  // Fan out an in-app notification to every admin/global admin so they see
  // new tickets in their bell dropdown without polling the admin page.
  try {
    const admins = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(inArray(usersTable.role, ADMIN_VIEW_ROLES as unknown as string[]));
    if (admins.length > 0) {
      await db.insert(notificationsTable).values(
        admins.map((a) => ({
          userId: a.id,
          type: "feedback_new",
          title: `New ${parsed.data.type} report`,
          message: parsed.data.title.slice(0, 140),
          resourceType: "feedback_ticket",
          resourceId: created.id,
        })),
      );
    }
  } catch (err) {
    logger.warn(
      { err, ticketId: created.id },
      "Failed to fan out feedback_new notifications",
    );
  }

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "feedback.create",
    tenantId,
    resourceType: "feedback_ticket",
    resourceId: String(created.id),
    metadata: { type: parsed.data.type, severity: parsed.data.severity },
    ipAddress: req.ip,
  });

  res.status(201).json(created);
});

// ─── GET /api/admin/feedback ─────────────────────────────────────────────────
router.get(
  ["/admin/feedback", "/feedback"],
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const parsed = ListQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const q = parsed.data;
    const isAdminPath = req.originalUrl.includes("/admin/feedback");
    const isAdmin = isAdminViewer(actor.role);
    if (isAdminPath && !isAdmin) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const conditions = isAdmin
      ? tenantScopedConditions(actor)
      : [eq(feedbackTicketsTable.submitterId, actor.id)];
    if (!isAdmin && actor.tenantId != null)
      conditions.push(eq(feedbackTicketsTable.tenantId, actor.tenantId));
    if (q.mine === "true")
      conditions.push(eq(feedbackTicketsTable.submitterId, actor.id));
    if (
      q.tenantId !== undefined &&
      normalizeFeedbackRole(actor.role) === "global_admin"
    )
      conditions.push(eq(feedbackTicketsTable.tenantId, q.tenantId));
    if (q.type) conditions.push(eq(feedbackTicketsTable.type, q.type));
    if (q.status) conditions.push(eq(feedbackTicketsTable.status, q.status));
    if (q.priority !== undefined)
      conditions.push(eq(feedbackTicketsTable.priority, q.priority));
    if (q.assigneeId !== undefined)
      conditions.push(eq(feedbackTicketsTable.assigneeId, q.assigneeId));
    if (q.dateFrom)
      conditions.push(
        gte(feedbackTicketsTable.createdAt, new Date(q.dateFrom)),
      );
    if (q.dateTo)
      conditions.push(lte(feedbackTicketsTable.createdAt, new Date(q.dateTo)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(feedbackTicketsTable)
      .where(where)
      .orderBy(
        desc(feedbackTicketsTable.priority),
        desc(feedbackTicketsTable.createdAt),
      );

    // Strip screenshotData from list payload to keep responses small. The
    // detail endpoint includes it.
    res.json({
      tickets: rows.map(({ screenshotData: _drop, ...rest }) => rest),
      total: rows.length,
    });
  },
);

// ─── GET /api/admin/feedback/:id ─────────────────────────────────────────────
router.get(
  ["/admin/feedback/:id", "/feedback/:id"],
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const id = parseInt(getRouteParam(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const isAdminPath = req.originalUrl.includes("/admin/feedback");
    const isAdmin = isAdminViewer(actor.role);
    if (isAdminPath && !isAdmin) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const conditions = isAdmin
      ? tenantScopedConditions(actor, id)
      : [
          eq(feedbackTicketsTable.id, id),
          eq(feedbackTicketsTable.submitterId, actor.id),
        ];
    if (!isAdmin && actor.tenantId != null)
      conditions.push(eq(feedbackTicketsTable.tenantId, actor.tenantId));
    const [row] = await db
      .select()
      .from(feedbackTicketsTable)
      .where(and(...conditions))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  },
);

// ─── PATCH /api/admin/feedback/:id ───────────────────────────────────────────
router.patch(
  ["/admin/feedback/:id", "/feedback/:id"],
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    if (!isAdminWriter(actor.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = parseInt(getRouteParam(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = UpdateTicketBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [existing] = await db
      .select()
      .from(feedbackTicketsTable)
      .where(and(...tenantScopedConditions(actor, id)))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const updates: Partial<typeof feedbackTicketsTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (parsed.data.status !== undefined) updates.status = parsed.data.status;
    if (parsed.data.priority !== undefined)
      updates.priority = parsed.data.priority;
    if (parsed.data.assigneeId !== undefined)
      updates.assigneeId = parsed.data.assigneeId;

    const [updated] = await db
      .update(feedbackTicketsTable)
      .set(updates)
      .where(and(...tenantScopedConditions(actor, id)))
      .returning();

    // Notify submitter if status changed (and they aren't the actor).
    if (
      parsed.data.status !== undefined &&
      parsed.data.status !== existing.status &&
      existing.submitterId !== actor.id
    ) {
      try {
        await db.insert(notificationsTable).values({
          userId: existing.submitterId,
          type: "feedback_status",
          title: "Your feedback was updated",
          message: `Status changed: ${existing.status} → ${parsed.data.status}`,
          resourceType: "feedback_ticket",
          resourceId: existing.id,
        });
      } catch (err) {
        logger.warn(
          { err, ticketId: id },
          "Failed to write feedback_status notification",
        );
      }
    }

    await writeAuditLog({
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: "feedback.update",
      tenantId: existing.tenantId,
      resourceType: "feedback_ticket",
      resourceId: String(existing.id),
      metadata: parsed.data,
      ipAddress: req.ip,
    });

    res.json(updated);
  },
);

// ─── GET /api/feedback/:id/comments ──────────────────────────────────────────
router.get(
  ["/admin/feedback/:id/comments", "/feedback/:id/comments"],
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const id = parseInt(getRouteParam(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [ticket] = await db
      .select()
      .from(feedbackTicketsTable)
      .where(eq(feedbackTicketsTable.id, id))
      .limit(1);
    if (!ticket) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const isAdmin = isAdminViewer(actor.role);
    if (
      isAdmin &&
      normalizeFeedbackRole(actor.role) !== "global_admin" &&
      actor.tenantId != null &&
      ticket.tenantId !== actor.tenantId
    ) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (
      !isAdmin &&
      (ticket.submitterId !== actor.id ||
        (actor.tenantId != null && ticket.tenantId !== actor.tenantId))
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const rows = await db
      .select()
      .from(feedbackTicketCommentsTable)
      .where(eq(feedbackTicketCommentsTable.ticketId, id))
      .orderBy(feedbackTicketCommentsTable.createdAt);

    // Hide internal admin notes from non-admin submitters.
    const visible = isAdmin ? rows : rows.filter((c) => !c.isInternal);
    res.json({ comments: visible });
  },
);

// ─── POST /api/feedback/:id/comments ─────────────────────────────────────────
router.post(
  ["/admin/feedback/:id/comments", "/feedback/:id/comments"],
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const id = parseInt(getRouteParam(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = AddCommentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [ticket] = await db
      .select()
      .from(feedbackTicketsTable)
      .where(eq(feedbackTicketsTable.id, id))
      .limit(1);
    if (!ticket) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const isAdmin = isAdminViewer(actor.role);
    if (
      isAdmin &&
      normalizeFeedbackRole(actor.role) !== "global_admin" &&
      actor.tenantId != null &&
      ticket.tenantId !== actor.tenantId
    ) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (
      !isAdmin &&
      (ticket.submitterId !== actor.id ||
        (actor.tenantId != null && ticket.tenantId !== actor.tenantId))
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    // Only admins can leave internal notes.
    const isInternal = isAdmin && parsed.data.isInternal === true;

    const [created] = await db
      .insert(feedbackTicketCommentsTable)
      .values({
        ticketId: id,
        authorId: actor.id,
        body: parsed.data.body,
        isInternal,
      })
      .returning();

    // Notify the other party (admin -> submitter, or submitter -> all admins).
    try {
      if (isAdmin && ticket.submitterId !== actor.id && !isInternal) {
        await db.insert(notificationsTable).values({
          userId: ticket.submitterId,
          type: "feedback_comment",
          title: "New reply on your feedback",
          message: parsed.data.body.slice(0, 140),
          resourceType: "feedback_ticket",
          resourceId: ticket.id,
        });
      } else if (!isAdmin) {
        const admins = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(
            inArray(usersTable.role, ADMIN_VIEW_ROLES as unknown as string[]),
          );
        if (admins.length > 0) {
          await db.insert(notificationsTable).values(
            admins.map((a) => ({
              userId: a.id,
              type: "feedback_comment",
              title: "New comment on a feedback ticket",
              message: parsed.data.body.slice(0, 140),
              resourceType: "feedback_ticket",
              resourceId: ticket.id,
            })),
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err, ticketId: id },
        "Failed to fan out feedback_comment notifications",
      );
    }

    res.status(201).json(created);
  },
);

async function setFeedbackStatus(
  req: import("express").Request,
  res: import("express").Response,
  status: "submitted" | "reviewed" | "closed",
): Promise<void> {
  const actor = req.dbUser!;
  if (!isAdminWriter(actor.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = parseInt(getRouteParam(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db
    .select()
    .from(feedbackTicketsTable)
    .where(and(...tenantScopedConditions(actor, id)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const updates: Partial<typeof feedbackTicketsTable.$inferInsert> = {
    status,
    updatedAt: new Date(),
  };
  if (status === "reviewed") {
    updates.reviewedAt = new Date();
    updates.reviewedByUserId = actor.id;
  }
  if (status === "closed") {
    updates.archivedAt = new Date();
    updates.archivedByUserId = actor.id;
  }
  const [updated] = await db
    .update(feedbackTicketsTable)
    .set(updates)
    .where(and(...tenantScopedConditions(actor, id)))
    .returning();
  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: `feedback.${status}`,
    tenantId: existing.tenantId,
    resourceType: "feedback_ticket",
    resourceId: String(existing.id),
    metadata: { from: existing.status, to: status },
    ipAddress: req.ip,
  });
  res.json(updated);
}

router.patch("/admin/feedback/:id/reviewed", (req, res) => {
  void setFeedbackStatus(req, res, "reviewed");
});
router.patch("/admin/feedback/:id/unread", (req, res) => {
  void setFeedbackStatus(req, res, "submitted");
});
router.patch("/admin/feedback/:id/archive", (req, res) => {
  void setFeedbackStatus(req, res, "closed");
});
router.patch("/admin/feedback/:id/restore", (req, res) => {
  void setFeedbackStatus(req, res, "submitted");
});
router.post(
  "/admin/feedback/:id/create-ticket",
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    if (!isAdminWriter(actor.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = parseInt(getRouteParam(req.params.id), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(feedbackTicketsTable)
      .where(and(...tenantScopedConditions(actor, id)))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [updated] = await db
      .update(feedbackTicketsTable)
      .set({
        status: "in_progress",
        priority: true,
        ticketId: `feedback-${id}`,
        updatedAt: new Date(),
      })
      .where(and(...tenantScopedConditions(actor, id)))
      .returning();
    await writeAuditLog({
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: "feedback.create_ticket",
      tenantId: existing.tenantId,
      resourceType: "feedback_ticket",
      resourceId: String(existing.id),
      metadata: { integration: "internal_priority_fix" },
      ipAddress: req.ip,
    });
    res.json({ ticket: updated, externalTicket: null });
  },
);

router.post(
  "/admin/feedback/archive-policy/run",
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    if (!isAdminWriter(actor.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const result = await runFeedbackAutoArchive(actor, req.ip);
    res.json(result);
  },
);

export default router;
