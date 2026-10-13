import { getAuth, clerkClient } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { fetchAndProvisionClerkUser, ensureProvisioningSchema, normalizeEmail } from "./userProvisioning";
import { normalizeClerkPublicMetadata, readClerkPublicMetadata } from "./clerkSync";

import { normalizeRole, hasRoleValue, type NormalizedRole } from "./roles";
import { getHouseTenantId } from "./singleTenant";
export { normalizeRole } from "./roles";

export type Role = NormalizedRole | string;


export function isConfiguredAccountOwner(user: { clerkId?: string | null } | null | undefined): boolean {
  const configuredOwnerId = process.env.MYORDER_OWNER_CLERK_ID?.trim();
  return Boolean(configuredOwnerId && user?.clerkId && user.clerkId === configuredOwnerId);
}

/** True only when the authenticated Clerk subject matches the configured owner and resolved DB row. */
export function isAuthenticatedConfiguredAccountOwner(req: Request, user: { clerkId?: string | null } | null | undefined): boolean {
  const authenticatedSubject = getAuth(req)?.userId;
  return !!authenticatedSubject && authenticatedSubject === user?.clerkId && isConfiguredAccountOwner(user);
}

export type AccountApprovalDecision =
  | { allowed: true; reason: "configured_owner_provenance_exception" | "valid_provenance" }
  | { allowed: false; reason: "missing_db_user" | "inactive" | "rejected" | "pending" | "missing_provenance" };

/** Shared approval policy. The owner exception satisfies provenance only; it
 * does not bypass account status, activity, tenant, role, or object checks. */
export function evaluateAccountApproval(req: Request, user: {
  clerkId?: string | null;
  status?: string | null;
  isActive?: boolean | null;
  approvedByClerkId?: string | null;
  approvedAt?: Date | string | null;
} | null | undefined): AccountApprovalDecision {
  if (!user) return { allowed: false, reason: "missing_db_user" };
  if (user.isActive === false || user.status === "deactivated") return { allowed: false, reason: "inactive" };
  if (user.status === "rejected") return { allowed: false, reason: "rejected" };
  if (user.status !== "approved") return { allowed: false, reason: "pending" };
  if (isAuthenticatedConfiguredAccountOwner(req, user)) return { allowed: true, reason: "configured_owner_provenance_exception" };
  const ownerId = process.env.MYORDER_OWNER_CLERK_ID?.trim();
  if (!ownerId || user.approvedByClerkId !== ownerId || !user.approvedAt) {
    return { allowed: false, reason: "missing_provenance" };
  }
  return { allowed: true, reason: "valid_provenance" };
}

let usersSchemaVerified = false;

/**
 * Authentication must never mutate schema during a request. Check the legacy
 * auth columns read-only; deployments with an incomplete users schema must
 * apply the reviewed migration before serving authenticated traffic.
 */
async function verifyUsersAuthSchema(): Promise<void> {
  if (usersSchemaVerified) return;

  await db.execute(sql`
    SELECT mfa_enabled, mfa_secret, mfa_backup_codes, first_name, last_name,
      contact_phone, avatar_url, status, is_active, is_default_tech,
      created_at, updated_at
    FROM users LIMIT 0
  `);
  usersSchemaVerified = true;
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

  await verifyUsersAuthSchema();
  await ensureProvisioningSchema();

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
    if (existing.tenantId === null && normalizeRole(existing.role) === "user") patch.tenantId = await getHouseTenantId();
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
      .where(sql`${usersTable.normalizedEmail} = ${normalizeEmail(email)} AND (${usersTable.clerkId} LIKE 'pending:%' OR ${usersTable.clerkId} LIKE 'pending\_%' OR ${usersTable.clerkId} = ${clerkId})`)
      .limit(1);
    if (byEmail) {
      // Claim this row — swap the sentinel/stale clerkId for the real one.
      logger.info({ clerkId, userId: byEmail.id, role: byEmail.role, status: byEmail.status }, "Claiming pre-approved user row by email match");
      const [updated] = await db
        .update(usersTable)
        .set({ clerkId, normalizedEmail: normalizeEmail(email), identityStatus: "verified", provisioningStatus: "active", provisioningError: null, updatedAt: new Date() })
        .where(eq(usersTable.id, byEmail.id))
        .returning();
      return updated ?? byEmail;
    }
  }

  // 4. Truly new user — create a pending row.
  try {
    const tenantId = await getHouseTenantId();
    const [created] = await db
      .insert(usersTable)
      .values({ clerkId, email, normalizedEmail: normalizeEmail(email), firstName: firstName ?? undefined, lastName: lastName ?? undefined, tenantId, role: "user", status: "pending", isActive: true, identityStatus: "verified", provisioningStatus: "active" })
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
        .where(sql`${usersTable.normalizedEmail} = ${normalizeEmail(email)} AND (${usersTable.clerkId} LIKE 'pending:%' OR ${usersTable.clerkId} LIKE 'pending\_%' OR ${usersTable.clerkId} = ${clerkId})`)
        .limit(1);
      if (byEmail) {
        const [updated] = await db
          .update(usersTable)
          .set({ clerkId, normalizedEmail: normalizeEmail(email), identityStatus: "verified", provisioningStatus: "active", provisioningError: null, updatedAt: new Date() })
          .where(eq(usersTable.id, byEmail.id))
          .returning();
        return updated ?? byEmail;
      }
    }

    try {
      const reconciled = await fetchAndProvisionClerkUser(clerkId, "login_reconciliation");
      if (reconciled.user) return reconciled.user;
    } catch (reconcileErr) {
      logger.error({ err: reconcileErr, clerkId }, "Login-time provisioning reconciliation failed");
    }
    logger.error({ err, clerkId }, "Failed to create or find user");
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Authentication required", code: "AUTHENTICATION_REQUIRED" });
    return;
  }
  next();
}

export function requireDbUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.dbUser) {
    res.status(401).json({ error: "Authenticated account profile unavailable", code: "AUTHENTICATION_REQUIRED" });
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
    if (!hasRoleValue(user.role, allowed)) {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }
    next();
  };
}

export function isGlobalAdmin(user: { role?: string | null } | null | undefined): boolean {
  return normalizeRole(user?.role) === "global_admin";
}

export function requireApproved(req: Request, res: Response, next: NextFunction): void {
  const user = req.dbUser;
  const decision = evaluateAccountApproval(req, user);
  if (decision.allowed) {
    next();
    return;
  }
  if (decision.reason === "missing_db_user") {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (decision.reason === "inactive") {
    res.status(403).json({ error: "Account deactivated", code: "ACCOUNT_DEACTIVATED", status: user?.status ?? "deactivated" });
    return;
  }
  if (decision.reason === "rejected") {
    res.status(403).json({ error: "Account rejected", code: "ACCOUNT_REJECTED", status: user?.status });
    return;
  }
  if (decision.reason === "pending") {
    res.status(403).json({ error: "Account pending approval", code: "ACCOUNT_PENDING_APPROVAL", status: user?.status ?? "pending" });
    return;
  }
  res.status(403).json({ error: "Account approval provenance required", code: "ACCOUNT_APPROVAL_PROVENANCE_REQUIRED", status: user?.status });
}

export function requireAccountOwner(req: Request, res: Response, next: NextFunction): void {
  if (!req.dbUser) {
    res.status(401).json({ error: "Authentication required", code: "AUTHENTICATION_REQUIRED" });
    return;
  }
  if (!isAuthenticatedConfiguredAccountOwner(req, req.dbUser)) {
    res.status(403).json({ error: "Configured account owner authorization required", code: "OWNER_AUTH_REQUIRED" });
    return;
  }
  next();
}

export function requireRecentOwnerAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  const claims = (auth?.sessionClaims ?? {}) as Record<string, unknown>;
  const authTime = typeof claims.auth_time === "number" ? claims.auth_time : null;
  const fva = Array.isArray(claims.fva) && typeof claims.fva[0] === "number" ? claims.fva[0] : null;
  const now = Math.floor(Date.now() / 1000);
  // Clerk fva values are minutes; auth_time is a Unix timestamp in seconds.
  const recent = (authTime !== null && authTime <= now && now - authTime <= 600) || (fva !== null && fva >= 0 && fva <= 10);
  if (!recent) {
    // Clerk's useReverification() recognizes this signed-session step-up hint.
    // The client retries only the request that the owner explicitly initiated,
    // after Clerk completes reverification; the API repeats this check.
    res.status(403).json({
      error: "Recent authentication required",
      code: "RECENT_AUTH_REQUIRED",
      clerk_error: {
        type: "forbidden",
        reason: "reverification-error",
        metadata: { reverification: { level: "first_factor", afterMinutes: 10 } },
      },
    });
    return;
  }
  next();
}

// Middleware that loads the DB user into req.dbUser.
//
// Database rows are authoritative for authorization. Clerk metadata is read
// for identity diagnostics only and never grants account approval.
export async function loadDbUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await getOrCreateDbUser(req);
  if (user) {
    const auth = getAuth(req);
    let meta = readClerkPublicMetadata(
      auth?.sessionClaims as Record<string, unknown> | undefined,
    );
    if ((!meta.role || !meta.status) && auth?.userId) {
      try {
        const clerkUser = await clerkClient.users.getUser(auth.userId);
        const apiMeta = normalizeClerkPublicMetadata(
          clerkUser.publicMetadata as Record<string, unknown> | undefined,
        );
        meta = {
          status: meta.status ?? apiMeta.status,
          role: meta.role ?? apiMeta.role,
        };
      } catch (err) {
        logger.warn({ err, clerkId: auth.userId }, "Could not fetch Clerk public metadata for DB user sync");
      }
    }
    const updates: Partial<typeof usersTable.$inferInsert> = {};
    if (meta.role) {
      const dbRole = normalizeRole(user.role);
      const clerkRole = normalizeRole(meta.role);
      if (clerkRole !== dbRole) {
        logger.warn(
          {
            userId: user.id,
            dbRoleRaw: user.role,
            dbRoleNormalized: dbRole,
            clerkRoleRaw: meta.role,
            clerkRoleNormalized: clerkRole,
            willWriteToDb: false,
          },
          "loadDbUser: ignoring Clerk role mismatch — database role is authoritative",
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
        logger.info(
          {
            userId: user.id,
            updates,
            finalRole: reconciled?.role ?? user.role,
            finalStatus: reconciled?.status ?? user.status,
          },
          "loadDbUser: DB user reconciled from Clerk metadata",
        );
        req.dbUser = reconciled ?? user;
      } catch (err) {
        logger.error({ err, userId: user.id, updates }, "Failed to reconcile DB user from Clerk metadata");
        req.dbUser = user;
      }
    } else {
      logger.info(
        {
          userId: user.id,
          dbRoleRaw: user.role,
          dbRoleNormalized: normalizeRole(user.role),
          status: user.status,
          isActive: user.isActive,
          clerkRoleJwt: meta.role ?? null,
          clerkStatusJwt: meta.status ?? null,
        },
        "loadDbUser: no sync needed — DB user loaded as-is",
      );
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

export async function hasPermission(user: { role?: string | null; tenantId?: number | null } | null | undefined, permission: string, tenantId?: number | null): Promise<boolean> {
  if (!user) return false;
  const { rolePermissionsTable } = await import("@workspace/db");
  const { defaultHasPermission } = await import("./roles");
  const actorRole = normalizeRole(user.role);
  if (actorRole === "global_admin") return true;
  const effectiveTenantId = tenantId ?? user.tenantId ?? null;
  try {
    const [override] = await db.select().from(rolePermissionsTable).where(sql`${rolePermissionsTable.role} = ${actorRole} AND ${rolePermissionsTable.permission} = ${permission} AND (${rolePermissionsTable.tenantId} = ${effectiveTenantId} OR (${effectiveTenantId} IS NULL AND ${rolePermissionsTable.tenantId} IS NULL))`).limit(1);
    if (override) return override.enabled;
  } catch (err) {
    logger.warn({ err, permission }, "Permission override lookup failed; falling back to defaults");
  }
  return defaultHasPermission(actorRole, permission);
}

export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.dbUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!(await hasPermission(req.dbUser, permission, req.dbUser.tenantId))) {
      res.status(403).json({ error: "Forbidden: missing permission", permission });
      return;
    }
    next();
  };
}

export function requireTenantScope() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.dbUser;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (normalizeRole(user.role) !== "global_admin" && !user.tenantId) {
      res.status(403).json({ error: "Forbidden: tenant scope required" });
      return;
    }
    next();
  };
}
