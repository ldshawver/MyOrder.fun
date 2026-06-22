import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import {
  ListNotificationsQueryParams,
  ListNotificationsResponse,
  MarkNotificationReadParams,
  MarkNotificationReadResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const KNOWN_NOTIFICATION_TYPES = new Set([
  "order_status",
  "onboarding_update",
  "admin_alert",
  "payment_update",
  "account_approved",
  "feedback_new",
]);

function normalizeNotificationType(type: string): "order_status" | "onboarding_update" | "admin_alert" | "payment_update" | "account_approved" | "feedback_new" {
  return KNOWN_NOTIFICATION_TYPES.has(type) ? type as ReturnType<typeof normalizeNotificationType> : "admin_alert";
}

router.get("/notifications", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const query = ListNotificationsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  let rows = await db.select().from(notificationsTable)
    .where(eq(notificationsTable.userId, actor.id))
    .orderBy(desc(notificationsTable.createdAt));

  if (query.data.unreadOnly) {
    rows = rows.filter(n => !n.isRead);
  }

  const unreadCount = rows.filter(n => !n.isRead).length;
  res.json(ListNotificationsResponse.parse({
    notifications: rows.map(n => ({
      id: n.id,
      userId: n.userId,
      type: normalizeNotificationType(n.type),
      title: n.title,
      message: n.message,
      isRead: n.isRead,
      resourceType: n.resourceType ?? undefined,
      resourceId: n.resourceId ?? undefined,
      createdAt: n.createdAt,
    })),
    unreadCount,
  }));
});

router.patch("/notifications/:id/read", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = MarkNotificationReadParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [notification] = await db.select().from(notificationsTable)
    .where(and(eq(notificationsTable.id, params.data.id), eq(notificationsTable.userId, actor.id)))
    .limit(1);

  if (!notification) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }

  const [updated] = await db.update(notificationsTable)
    .set({ isRead: true })
    .where(eq(notificationsTable.id, params.data.id))
    .returning();

  res.json(MarkNotificationReadResponse.parse({
    id: updated.id,
    userId: updated.userId,
    type: normalizeNotificationType(updated.type),
    title: updated.title,
    message: updated.message,
    isRead: updated.isRead,
    resourceType: updated.resourceType ?? undefined,
    resourceId: updated.resourceId ?? undefined,
    createdAt: updated.createdAt,
  }));
});

export default router;
