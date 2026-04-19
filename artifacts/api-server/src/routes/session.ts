import { Router, type IRouter } from "express";
import { db, auditLogsTable } from "@workspace/db";
import { requireAuth, loadDbUser } from "../lib/auth";

const router: IRouter = Router();

router.post("/session/log", requireAuth, loadDbUser, async (req, res): Promise<void> => {
  const user = req.dbUser;
  if (!user) {
    res.status(204).end();
    return;
  }

  const { page, action } = req.body as { page?: string; action?: string };

  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  try {
    await db.insert(auditLogsTable).values({
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email ?? "",
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
  } catch {
    // silently swallow — logging must never break the app
  }
  res.status(204).end();
});

export default router;
