import { getAuth, clerkClient } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { readClerkPublicMetadata } from "./clerkSync";

export type CanonicalRole =
  | "global_admin"
  | "admin"
  | "customer_service_rep"
  | "user";

export type LegacyRole =
  | "supervisor"
  | "csr"
  | "qsr"
  | "customer_service"
  | "customer_service_specialist"
  | "business_sitter"
  | "sales_rep"
  | "lab_tech"
  | "lab_technician"
  | "customer";

export type Role = CanonicalRole | LegacyRole;

export function normalizeRole(role: unknown): CanonicalRole {
  if (role === "global_admin") return "global_admin";
  if (role === "admin" || role === "supervisor") return "admin";
  if (
    role === "customer_service_rep" ||
    role === "csr" ||
    role === "qsr" ||
    role === "customer_service" ||
    role === "customer_service_specialist" ||
    role === "business_sitter" ||
    role === "sales_rep" ||
    role === "lab_tech" ||
    role === "lab_technician"
  ) {
    return "customer_service_rep";
  }
  return "user";
}

// Staff roles are implicitly approved — having been assigned a staff role
// by an admin is itself the approval gate. Keep this list in sync with
// requireApproved below.
export const STAFF_ROLES: readonly CanonicalRole[] = [
  "global_admin",
  "admin",
  "customer_service_rep",
] as const;

let usersSchemaEnsured = false;

async function ensureUsersAuthSchema(): Promise<void> {
  if (usersSchemaEnsured) return;

  const statements = [
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enabled" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_secret" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_backup_codes" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_name" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_name" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "contact_phone" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'pending'`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_default_tech" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL`,
  ];

  for (const statement of statements) {
    await db.execute(statement);
  }
  usersSchemaEnsured = true;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      dbUser?: typeof usersTable.$inferSelect;
    }
  }
}

export async function getOrCreateDbUser(req: Request): Promise<typeof usersTable.$inferSelect | null> {
  const auth = getAuth(req);
  if (!auth?.userId) return null;

  await ensureUsersAuthSchema();

  const clerkId = auth.userId;

  // 1. Fast path: existing row by clerkId
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId))
    .limit(1);

  if (existing) {
    const auth = getAuth(req);
    const claimFirstName = (auth.sessionClaims?.firstName as string) || (auth.sessionClaims?.given_name as string) || null;
    const claimLastName = (auth.sessionClaims?.lastName as string) || (auth.sessionClaims?.family_name as string) || null;
    const patch: Partial<typeof usersTable.$inferInsert> = {};
    if (!existing.firstName && claimFirstName) patch.firstName = claimFirstName;
    if (!existing.lastName && claimLastName) patch.lastName = claimLastName;
    if (Object.keys(patch).length > 0) {
      const [updated] = await db.update(usersTable).set(patch).where(eq(usersTable.id, existing.id)).returning();
      return updated ?? existing;
    }
    return existing;
  }

  // 2. Extract user info from Clerk session claims (JWT doesn't always include email,
  //    so fall back to the Clerk API to get the canonical email address).
  const claimEmail = (auth.sessionClaims?.email as string) || (auth.sessionClaims?.primaryEmailAddress as string) || "";
  const firstName = (auth.sessionClaims?.firstName as string) || (auth.sessionClaims?.given_name as string) || null;
  const lastName = (auth.sessionClaims?.lastName as string) || (auth.sessionClaims?.family_name as string) || null;

  let email: string | null = claimEmail || null;
  try {
    if (!email) {
      // JWT didn't carry the email — fetch it directly from Clerk.
      const clerkUser = await clerkClient.users.getUser(clerkId);
      email = clerkUser.emailAddresses[0]?.emailAddress ?? null;
    }
  } catch (err) {
    logger.warn({ err, clerkId }, "Could not fetch email from Clerk API; proceeding without email");
  }

  // 3. Before inserting, look for a pre-approved row by email (e.g. a sentinel
  //    row created during waitlist approval). This is the critical step that
  //    prevents a fresh pending/user row from shadowing an approved invitation.
  if (email) {
    const [byEmail] = await db
      .select()
      .from(usersTable)
      .where(sql`lower(${usersTable.email}) = lower(${email})`)
      .limit(1);
    if (byEmail) {
      // Claim this row — swap the sentinel/stale clerkId for the real one.
      logger.info({ clerkId, userId: byEmail.id, role: byEmail.role, status: byEmail.status }, "Claiming pre-approved user row by email match");
      const [updated] = await db
        .update(usersTable)
        .set({ clerkId, updatedAt: new Date() })
        .where(eq(usersTable.id, byEmail.id))
        .returning();
      return updated ?? byEmail;
    }
  }

  // 4. Truly new user — create a pending row.
  try {
    const [created] = await db
      .insert(usersTable)
      .values({ clerkId, email, firstName: firstName ?? undefined, lastName: lastName ?? undefined, role: "user" })
      .returning();
    return created;
  } catch (err) {
    logger.warn({ clerkId }, "User insert failed (conflict), looking up by clerkId or email");
    // Race condition: another request beat us to the insert.
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
        .where(sql`lower(${usersTable.email}) = lower(${email})`)
        .limit(1);
      if (byEmail) {
        const [updated] = await db
          .update(usersTable)
          .set({ clerkId, updatedAt: new Date() })
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
    const allowed = roles.map(normalizeRole);
    const actorRole = normalizeRole(user.role);
    const hasRole = allowed.includes(actorRole) || (actorRole === "global_admin" && allowed.includes("admin"));
    if (!hasRole) {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }
    next();
  };
}

export function requireApproved(req: Request, res: Response, next: NextFunction): void {
  const user = req.dbUser;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // Elevated/staff roles are implicitly approved — having been assigned a
  // staff role by an admin is itself the approval gate. Only end-customer
  // "user" accounts require an explicit status check.
  if ((STAFF_ROLES as readonly string[]).includes(normalizeRole(user.role))) {
    next();
    return;
  }
  if (user.status !== "approved") {
    res.status(403).json({ error: "Account pending approval", status: user.status ?? "pending" });
    return;
  }
  next();
}

// Middleware that loads the DB user into req.dbUser.
//
// Sync-on-read: Clerk's publicMetadata is the source of truth for status/role
// at sign-in time. If the JWT carries a status/role that differs from the DB
// row, reconcile the DB to match Clerk so manual dashboard changes propagate.
export async function loadDbUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await getOrCreateDbUser(req);
  if (user) {
    const auth = getAuth(req);
    const meta = readClerkPublicMetadata(
      auth?.sessionClaims as Record<string, unknown> | undefined,
    );
    const updates: Partial<typeof usersTable.$inferInsert> = {};
    if (meta.status && meta.status !== user.status) {
      // Never let stale Clerk metadata downgrade an approved user back to
      // pending. Approval is an admin action that goes through the app (which
      // updates both DB and Clerk together). If they're out of sync it means
      // Clerk has a stale value — the DB 'approved' state wins.
      const isDowngrade = user.status === "approved" && meta.status === "pending";
      if (!isDowngrade) {
        updates.status = meta.status;
      } else {
        logger.warn(
          { userId: user.id, dbStatus: user.status, clerkStatus: meta.status },
          "Ignoring Clerk metadata status downgrade (approved → pending) — DB is authoritative",
        );
      }
    }
    if (meta.role && meta.role !== user.role) {
      // Never let stale Clerk metadata demote a staff member back to 'user'.
      // Role elevations come through the admin UI which syncs both DB + Clerk
      // together. If they're out of sync here it means Clerk has a stale value
      // (e.g. user was promoted via direct DB change) — the DB staff role wins.
      const dbRole = normalizeRole(user.role);
      const clerkRole = normalizeRole(meta.role);
      const isRoleDowngrade =
        (STAFF_ROLES as readonly string[]).includes(dbRole) &&
        !(STAFF_ROLES as readonly string[]).includes(clerkRole);
      if (!isRoleDowngrade) {
        updates.role = clerkRole;
      } else {
        logger.warn(
          { userId: user.id, dbRole: user.role, clerkRole: meta.role },
          "Ignoring Clerk metadata role downgrade (staff → user) — DB is authoritative",
        );
      }
    }
    if (Object.keys(updates).length > 0) {
      try {
        const [reconciled] = await db
          .update(usersTable)
          .set(updates)
          .where(eq(usersTable.id, user.id))
          .returning();
        req.dbUser = reconciled ?? user;
      } catch (err) {
        logger.error({ err, userId: user.id, updates }, "Failed to reconcile DB user from Clerk metadata");
        req.dbUser = user;
      }
    } else {
      req.dbUser = user;
    }
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
