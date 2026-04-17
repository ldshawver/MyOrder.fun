import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, auditLogsTable } from "@workspace/db";
import {
  ListAuditLogsQueryParams,
  ListAuditLogsResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole("admin", "supervisor"));

router.get("/audit", async (req, res): Promise<void> => {
  const query = ListAuditLogsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  let rows = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt));

  if (query.data.action) rows = rows.filter(r => r.action === query.data.action);
  if (query.data.actorId) rows = rows.filter(r => r.actorId === query.data.actorId);

  const page = query.data.page ?? 1;
  const limit = query.data.limit ?? 50;
  const total = rows.length;
  const paged = rows.slice((page - 1) * limit, page * limit);

  res.json(ListAuditLogsResponse.parse({
    entries: paged.map(e => ({
      id: e.id,
      tenantId: e.tenantId,
      actorId: e.actorId,
      actorEmail: e.actorEmail,
      actorRole: e.actorRole,
      action: e.action,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      metadata: e.metadata,
      ipAddress: e.ipAddress,
      createdAt: e.createdAt,
    })),
    total,
    page,
    limit,
  }));
});

export default router;
