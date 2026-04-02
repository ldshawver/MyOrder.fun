import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export type Role = "global_admin" | "tenant_admin" | "staff" | "customer";

declare global {
  namespace Express {
    interface Request {
      dbUser?: typeof usersTable.$inferSelect;
      tenantId?: number;
    }
  }
}

export async function getOrCreateDbUser(req: Request): Promise<typeof usersTable.$inferSelect | null> {
  const auth = getAuth(req);
  if (!auth?.userId) return null;

  const clerkId = auth.userId;

  // Try to find existing user by clerkId first
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId))
    .limit(1);

  if (existing) return existing;

  // Extract user info from Clerk session claims
  const rawEmail = (auth.sessionClaims?.email as string) || (auth.sessionClaims?.primaryEmailAddress as string) || "";
  const firstName = (auth.sessionClaims?.firstName as string) || (auth.sessionClaims?.given_name as string) || null;
  const lastName = (auth.sessionClaims?.lastName as string) || (auth.sessionClaims?.family_name as string) || null;
  // Store null instead of empty string to avoid unique constraint conflicts
  const email = rawEmail || null;

  try {
    const [created] = await db
      .insert(usersTable)
      .values({ clerkId, email, firstName: firstName ?? undefined, lastName: lastName ?? undefined, role: "customer" })
      .returning();
    return created;
  } catch (err) {
    logger.warn({ clerkId }, "User insert failed (conflict), looking up by clerkId or email");
    // On conflict (race condition or email reuse), look up by clerkId first, then by email if non-null
    const [byClerkId] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkId, clerkId))
      .limit(1);
    if (byClerkId) return byClerkId;

    if (email) {
      const [byEmail] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      if (byEmail) {
        // Claim this record by updating the clerkId
        const [updated] = await db
          .update(usersTable)
          .set({ clerkId })
          .where(eq(usersTable.id, byEmail.id))
          .returning();
        return updated ?? byEmail;
      }
    }

    logger.error({ err, clerkId }, "Failed to create or find user");
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function requireDbUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.dbUser) {
    res.status(401).json({ error: "User profile not found" });
    return;
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.dbUser;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(user.role as Role)) {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }
    next();
  };
}

// Middleware that loads the DB user into req.dbUser
export async function loadDbUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await getOrCreateDbUser(req);
  if (user) {
    req.dbUser = user;
    req.tenantId = user.tenantId ?? undefined;
  }
  next();
}

// Helper to emit audit log (fire-and-forget)
export async function writeAuditLog(params: {
  actorId: number;
  actorEmail: string | null | undefined;
  actorRole: string;
  action: string;
  tenantId?: number | null;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}): Promise<void> {
  const { auditLogsTable } = await import("@workspace/db");
  try {
    await db.insert(auditLogsTable).values({
      actorId: params.actorId,
      actorEmail: params.actorEmail ?? "",
      actorRole: params.actorRole,
      action: params.action,
      tenantId: params.tenantId ?? null,
      resourceType: params.resourceType ?? null,
      resourceId: params.resourceId ?? null,
      metadata: params.metadata ?? {},
      ipAddress: params.ipAddress ?? null,
    });
  } catch (err) {
    logger.error({ err, action: params.action }, "Failed to write audit log");
  }
}
