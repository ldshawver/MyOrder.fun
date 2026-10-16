import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, auditLogsTable } from "@workspace/db";
import {
  ListAuditLogsQueryParams,
  ListAuditLogsResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";
import { requirePermission } from "../lib/roles";

const router: IRouter = Router();
const auditAuth = [requireAuth, loadDbUser, requireDbUser, requireApproved, requirePermission("platform.tenants.view")] as const;

router.get("/audit", ...auditAuth, async (req, res): Promise<void> => {
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
      tenantId: e.tenantId ?? undefined,
      actorId: e.actorId,
      actorEmail: e.actorEmail,
      actorRole: e.actorRole,
      action: e.action,
      resourceType: e.resourceType ?? undefined,
      resourceId: e.resourceId ?? undefined,
      metadata: e.metadata ?? undefined,
      ipAddress: e.ipAddress ?? undefined,
      createdAt: e.createdAt,
    })),
    total,
    page,
    limit,
  }));
});

export default router;
