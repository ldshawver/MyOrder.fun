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
      type: n.type,
      title: n.title,
      message: n.message,
      isRead: n.isRead,
      resourceType: n.resourceType,
      resourceId: n.resourceId,
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
    type: updated.type,
    title: updated.title,
    message: updated.message,
    isRead: updated.isRead,
    resourceType: updated.resourceType,
    resourceId: updated.resourceId,
    createdAt: updated.createdAt,
  }));
});

export default router;
