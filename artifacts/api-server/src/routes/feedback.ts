/**
 * Feedback & Bug Reporting routes.
 *
 * RBAC summary:
 *   - Any authenticated, approved user can POST a new ticket.
 *   - Regular users can only list/view/comment on tickets THEY submitted.
 *     The DB query filters by submitterId — there is no client-supplied
 *     filter that bypasses this.
 *   - Admins (role=admin) can list/view/update/comment on every ticket.
 *   - Supervisors get the same read+update powers as admins on tickets so
 *     the team can triage without granting full admin. (Adjust the
 *     ADMIN_VIEW_ROLES list below to tighten this if needed.)
 *
 * Tenant isolation: this deploy is single-tenant (house tenant id=1) so
 * the tenantId column is captured for forward compat but no per-tenant
 * filter is enforced beyond "regular users only see their own". A
 * `tenantId` filter param is honoured for admins.
 *
 * Notifications: in-app only, written into the existing notifications
 * table (no email dependency). Submitter is notified on status change;
 * every admin/supervisor is notified on new ticket creation.
 */
import { Router, type IRouter } from "express";
import { eq, and, desc, gte, lte, inArray } from "drizzle-orm";
import {
  db,
  feedbackTicketsTable,
  feedbackTicketCommentsTable,
  notificationsTable,
  usersTable,
} from "@workspace/db";
import { z } from "zod/v4";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, writeAuditLog } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const ADMIN_VIEW_ROLES = ["admin", "supervisor"] as const;
const ADMIN_WRITE_ROLES = ["admin", "supervisor"] as const;

const FEEDBACK_TYPES = ["bug", "ux", "feature", "general"] as const;
const FEEDBACK_SEVERITIES = ["low", "medium", "high", "critical"] as const;
const FEEDBACK_STATUSES = [
  "new",
  "reviewed",
  "priority_fix",
  "in_progress",
  "waiting_on_user",
  "closed",
  "rejected",
] as const;

// 2 MB cap on inline base64 screenshots. Anything bigger and the user
// should be using a dedicated upload service — out of scope for v1.
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

const CreateTicketBody = z.object({
  type: z.enum(FEEDBACK_TYPES),
  severity: z.enum(FEEDBACK_SEVERITIES).default("medium"),
  title: z.string().min(3).max(200),
  description: z.string().min(5).max(10_000),
  pageUrl: z.string().max(2048).nullable().optional(),
  userAgent: z.string().max(1024).nullable().optional(),
  screenshotData: z.string().max(MAX_SCREENSHOT_BYTES * 2).nullable().optional(),
});

const UpdateTicketBody = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  priority: z.boolean().optional(),
  assigneeId: z.number().int().positive().nullable().optional(),
}).refine(
  (v) => v.status !== undefined || v.priority !== undefined || v.assigneeId !== undefined,
  { message: "At least one of status, priority, assigneeId is required" },
);

const ListQueryParams = z.object({
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
});

const AddCommentBody = z.object({
  body: z.string().min(1).max(5000),
  isInternal: z.boolean().optional().default(false),
});

function isAdminViewer(role: string): boolean {
  return (ADMIN_VIEW_ROLES as readonly string[]).includes(role);
}
function isAdminWriter(role: string): boolean {
  return (ADMIN_WRITE_ROLES as readonly string[]).includes(role);
}

// ─── POST /api/feedback ──────────────────────────────────────────────────────
router.post("/feedback", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const parsed = CreateTicketBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Reject oversized screenshots cleanly instead of letting Postgres choke.
  if (parsed.data.screenshotData && parsed.data.screenshotData.length > MAX_SCREENSHOT_BYTES * 2) {
    res.status(413).json({ error: "Screenshot exceeds 2MB limit" });
    return;
  }

  // Defence-in-depth against data-URI XSS: only allow real raster image
  // data URLs. Without this an attacker could submit `javascript:alert(1)`
  // (or a crafted `data:image/svg+xml,<script>…`) which would fire when an
  // admin clicked the screenshot link in the dashboard.
  if (parsed.data.screenshotData) {
    const ok = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(parsed.data.screenshotData);
    if (!ok) {
      res.status(400).json({ error: "Screenshot must be a base64 PNG/JPEG/GIF/WebP data URL" });
      return;
    }
  }

  const tenantId = await getHouseTenantId().catch(() => null);

  const [created] = await db.insert(feedbackTicketsTable).values({
    tenantId,
    submitterId: actor.id,
    type: parsed.data.type,
    severity: parsed.data.severity,
    status: "new",
    priority: false,
    title: parsed.data.title,
    description: parsed.data.description,
    pageUrl: parsed.data.pageUrl ?? null,
    userAgent: parsed.data.userAgent ?? null,
    screenshotData: parsed.data.screenshotData ?? null,
  }).returning();

  // Fan out an in-app notification to every admin/supervisor so they see
  // new tickets in their bell dropdown without polling the admin page.
  try {
    const admins = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(inArray(usersTable.role, ADMIN_VIEW_ROLES as unknown as string[]));
    if (admins.length > 0) {
      await db.insert(notificationsTable).values(admins.map((a) => ({
        userId: a.id,
        type: "feedback_new",
        title: `New ${parsed.data.type} report`,
        message: parsed.data.title.slice(0, 140),
        resourceType: "feedback_ticket",
        resourceId: created.id,
      })));
    }
  } catch (err) {
    logger.warn({ err, ticketId: created.id }, "Failed to fan out feedback_new notifications");
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

// ─── GET /api/feedback ───────────────────────────────────────────────────────
router.get("/feedback", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const parsed = ListQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const q = parsed.data;
  const isAdmin = isAdminViewer(actor.role);

  const conditions = [];

  // Hard isolation: non-admins are pinned to their own tickets, no matter
  // what the query string says. Admins can opt in to "mine" or filter by
  // any tenant/assignee freely.
  if (!isAdmin) {
    conditions.push(eq(feedbackTicketsTable.submitterId, actor.id));
  } else if (q.mine === "true") {
    conditions.push(eq(feedbackTicketsTable.submitterId, actor.id));
  }

  if (q.tenantId !== undefined) conditions.push(eq(feedbackTicketsTable.tenantId, q.tenantId));
  if (q.type) conditions.push(eq(feedbackTicketsTable.type, q.type));
  if (q.status) conditions.push(eq(feedbackTicketsTable.status, q.status));
  if (q.priority !== undefined) conditions.push(eq(feedbackTicketsTable.priority, q.priority));
  if (q.assigneeId !== undefined) conditions.push(eq(feedbackTicketsTable.assigneeId, q.assigneeId));
  if (q.dateFrom) conditions.push(gte(feedbackTicketsTable.createdAt, new Date(q.dateFrom)));
  if (q.dateTo) conditions.push(lte(feedbackTicketsTable.createdAt, new Date(q.dateTo)));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db.select().from(feedbackTicketsTable)
    .where(where)
    .orderBy(desc(feedbackTicketsTable.priority), desc(feedbackTicketsTable.createdAt));

  // Strip screenshotData from list payload to keep responses small. The
  // detail endpoint includes it.
  res.json({
    tickets: rows.map(({ screenshotData: _drop, ...rest }) => rest),
    total: rows.length,
  });
});

// ─── GET /api/feedback/:id ───────────────────────────────────────────────────
router.get("/feedback/:id", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db.select().from(feedbackTicketsTable)
    .where(eq(feedbackTicketsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (!isAdminViewer(actor.role) && row.submitterId !== actor.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(row);
});

// ─── PATCH /api/feedback/:id ─────────────────────────────────────────────────
router.patch("/feedback/:id", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  if (!isAdminWriter(actor.role)) {
    res.status(403).json({ error: "Admin or supervisor required" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = UpdateTicketBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [existing] = await db.select().from(feedbackTicketsTable)
    .where(eq(feedbackTicketsTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const updates: Partial<typeof feedbackTicketsTable.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;
  if (parsed.data.priority !== undefined) updates.priority = parsed.data.priority;
  if (parsed.data.assigneeId !== undefined) updates.assigneeId = parsed.data.assigneeId;

  const [updated] = await db.update(feedbackTicketsTable)
    .set(updates)
    .where(eq(feedbackTicketsTable.id, id))
    .returning();

  // Notify submitter if status changed (and they aren't the actor).
  if (parsed.data.status !== undefined
      && parsed.data.status !== existing.status
      && existing.submitterId !== actor.id) {
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
      logger.warn({ err, ticketId: id }, "Failed to write feedback_status notification");
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
});

// ─── GET /api/feedback/:id/comments ──────────────────────────────────────────
router.get("/feedback/:id/comments", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [ticket] = await db.select().from(feedbackTicketsTable)
    .where(eq(feedbackTicketsTable.id, id)).limit(1);
  if (!ticket) { res.status(404).json({ error: "Not found" }); return; }

  const isAdmin = isAdminViewer(actor.role);
  if (!isAdmin && ticket.submitterId !== actor.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rows = await db.select().from(feedbackTicketCommentsTable)
    .where(eq(feedbackTicketCommentsTable.ticketId, id))
    .orderBy(feedbackTicketCommentsTable.createdAt);

  // Hide internal admin notes from non-admin submitters.
  const visible = isAdmin ? rows : rows.filter((c) => !c.isInternal);
  res.json({ comments: visible });
});

// ─── POST /api/feedback/:id/comments ─────────────────────────────────────────
router.post("/feedback/:id/comments", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = AddCommentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [ticket] = await db.select().from(feedbackTicketsTable)
    .where(eq(feedbackTicketsTable.id, id)).limit(1);
  if (!ticket) { res.status(404).json({ error: "Not found" }); return; }

  const isAdmin = isAdminViewer(actor.role);
  if (!isAdmin && ticket.submitterId !== actor.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Only admins can leave internal notes.
  const isInternal = isAdmin && parsed.data.isInternal === true;

  const [created] = await db.insert(feedbackTicketCommentsTable).values({
    ticketId: id,
    authorId: actor.id,
    body: parsed.data.body,
    isInternal,
  }).returning();

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
      const admins = await db.select({ id: usersTable.id })
        .from(usersTable)
        .where(inArray(usersTable.role, ADMIN_VIEW_ROLES as unknown as string[]));
      if (admins.length > 0) {
        await db.insert(notificationsTable).values(admins.map((a) => ({
          userId: a.id,
          type: "feedback_comment",
          title: "New comment on a feedback ticket",
          message: parsed.data.body.slice(0, 140),
          resourceType: "feedback_ticket",
          resourceId: ticket.id,
        })));
      }
    }
  } catch (err) {
    logger.warn({ err, ticketId: id }, "Failed to fan out feedback_comment notifications");
  }

  res.status(201).json(created);
});

export default router;
