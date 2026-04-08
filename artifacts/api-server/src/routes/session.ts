import { Router, type IRouter } from "express";
import { db, auditLogsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser } from "../lib/auth";

const router: IRouter = Router();

router.post("/session/log", requireAuth, loadDbUser, requireDbUser, async (req, res): Promise<void> => {
  const user = req.dbUser!;
  const { page, action } = req.body as { page?: string; action?: string };

  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  try {
    await db.insert(auditLogsTable).values({
      tenantId: user.tenantId,
      actorId: String(user.id),
      actorEmail: user.email,
      actorRole: user.role,
      action: action ?? "page_view",
      resourceType: "page",
      resourceId: page ?? "/",
      metadata: {
        userAgent: req.headers["user-agent"] ?? "",
        timestamp: new Date().toISOString(),
      },
      ipAddress: ip,
    });
    res.status(204).end();
  } catch {
    res.status(204).end();
  }
});

export default router;
