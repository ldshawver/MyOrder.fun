import { clerkClient } from "@clerk/express";
import { db, usersTable, tenantsTable, auditLogsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { normalizeRole } from "./roles";

export type ClerkProvisioningUser = {
  id: string;
  emailAddresses?: Array<{ id?: string | null; emailAddress?: string | null; email_address?: string | null; verification?: { status?: string | null } | null }>;
  primaryEmailAddressId?: string | null;
  primary_email_address_id?: string | null;
  firstName?: string | null;
  first_name?: string | null;
  lastName?: string | null;
  last_name?: string | null;
  phoneNumbers?: Array<{ id?: string | null; phoneNumber?: string | null; phone_number?: string | null }>;
  primaryPhoneNumberId?: string | null;
  primary_phone_number_id?: string | null;
};

export type ProvisioningResult = { user: typeof usersTable.$inferSelect | null; status: "created" | "updated" | "linked" | "skipped" | "failed"; correlationId: string; error?: string };

export function makeCorrelationId(prefix = "prov"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed || null;
}

export function getPrimaryVerifiedEmail(user: ClerkProvisioningUser): { email: string | null; normalizedEmail: string | null; verified: boolean } {
  const addresses = user.emailAddresses ?? (user as unknown as { email_addresses?: ClerkProvisioningUser["emailAddresses"] }).email_addresses ?? [];
  const primaryId = user.primaryEmailAddressId ?? user.primary_email_address_id ?? null;
  const primary = addresses.find((e) => e.id === primaryId) ?? addresses[0];
  const email = primary?.emailAddress ?? primary?.email_address ?? null;
  const verified = primary?.verification?.status === "verified" || !primary?.verification;
  return { email, normalizedEmail: normalizeEmail(email), verified };
}

export function getPrimaryPhone(user: ClerkProvisioningUser): string | null {
  const phones = user.phoneNumbers ?? (user as unknown as { phone_numbers?: ClerkProvisioningUser["phoneNumbers"] }).phone_numbers ?? [];
  const primaryId = user.primaryPhoneNumberId ?? user.primary_phone_number_id ?? null;
  const primary = phones.find((p) => p.id === primaryId) ?? phones[0];
  return primary?.phoneNumber ?? primary?.phone_number ?? null;
}

export async function ensureProvisioningSchema(): Promise<void> {
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "normalized_email" text`);
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "identity_status" text NOT NULL DEFAULT 'verification_pending'`);
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "provisioning_status" text NOT NULL DEFAULT 'pending'`);
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "provisioning_error" text`);
  await db.execute(sql`UPDATE "users" SET "normalized_email" = lower(trim("email")) WHERE "normalized_email" IS NULL AND "email" IS NOT NULL`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "users_normalized_email_unique" ON "users" ("normalized_email") WHERE "normalized_email" IS NOT NULL`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "clerk_webhook_events" ("id" text PRIMARY KEY, "event_type" text NOT NULL, "clerk_user_id" text, "processed_at" timestamp with time zone DEFAULT now() NOT NULL, "status" text NOT NULL DEFAULT 'processed', "error" text)`);
}

async function defaultTenantId(): Promise<number | null> {
  const slug = process.env.DEFAULT_TENANT_SLUG || process.env.MYORDER_DEFAULT_TENANT_SLUG || "myorder";
  const [bySlug] = await db.select().from(tenantsTable).where(eq(tenantsTable.slug, slug)).limit(1);
  if (bySlug) return bySlug.id;
  const [first] = await db.select().from(tenantsTable).limit(1);
  return first?.id ?? null;
}

export async function provisionVerifiedClerkUser(input: { clerkUser: ClerkProvisioningUser; correlationId?: string; source: string; requireVerified?: boolean }): Promise<ProvisioningResult> {
  const correlationId = input.correlationId ?? makeCorrelationId();
  await ensureProvisioningSchema();
  const clerkUser = input.clerkUser;
  const clerkId = clerkUser.id;
  const { email, normalizedEmail, verified } = getPrimaryVerifiedEmail(clerkUser);
  if (!clerkId || !normalizedEmail) return { user: null, status: "skipped", correlationId, error: "missing_identity" };
  if (input.requireVerified !== false && !verified) return { user: null, status: "skipped", correlationId, error: "email_not_verified" };
  const tenantId = await defaultTenantId();
  const firstName = clerkUser.firstName ?? clerkUser.first_name ?? null;
  const lastName = clerkUser.lastName ?? clerkUser.last_name ?? null;
  const contactPhone = getPrimaryPhone(clerkUser);
  try {
    const [byClerk] = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (byClerk) {
      const [updated] = await db.update(usersTable).set({ email, normalizedEmail, firstName: firstName ?? byClerk.firstName, lastName: lastName ?? byClerk.lastName, contactPhone: contactPhone ?? byClerk.contactPhone, identityStatus: verified ? "verified" : "verification_pending", provisioningStatus: "active", provisioningError: null, updatedAt: new Date() }).where(eq(usersTable.id, byClerk.id)).returning();
      return { user: updated ?? byClerk, status: "updated", correlationId };
    }
    const [byEmail] = await db.select().from(usersTable).where(sql`${usersTable.normalizedEmail} = ${normalizedEmail}`).limit(1);
    if (byEmail) {
      if (byEmail.clerkId && !byEmail.clerkId.startsWith("pending_")) {
        await db.update(usersTable).set({ identityStatus: "identity_mismatch", provisioningStatus: "provisioning_failed", provisioningError: "normalized_email_collision" }).where(eq(usersTable.id, byEmail.id));
        logger.warn({ correlationId, clerkId, userId: byEmail.id }, "Provisioning blocked by normalized email collision");
        return { user: byEmail, status: "failed", correlationId, error: "normalized_email_collision" };
      }
      const [linked] = await db.update(usersTable).set({ clerkId, email, normalizedEmail, firstName: firstName ?? byEmail.firstName, lastName: lastName ?? byEmail.lastName, contactPhone: contactPhone ?? byEmail.contactPhone, tenantId: byEmail.tenantId ?? tenantId, role: normalizeRole(byEmail.role), status: byEmail.status === "pending" ? "approved" : byEmail.status, isActive: true, identityStatus: "verified", provisioningStatus: "active", provisioningError: null, updatedAt: new Date() }).where(eq(usersTable.id, byEmail.id)).returning();
      await auditProvisioning(linked ?? byEmail, "USER_RECONCILED_LINKED", correlationId, input.source);
      return { user: linked ?? byEmail, status: "linked", correlationId };
    }
    const [created] = await db.insert(usersTable).values({ clerkId, email, normalizedEmail, firstName, lastName, contactPhone, tenantId, role: "user", status: "approved", isActive: true, identityStatus: "verified", provisioningStatus: "active" }).returning();
    await auditProvisioning(created, "USER_PROVISIONED", correlationId, input.source);
    return { user: created, status: "created", correlationId };
  } catch (err) {
    logger.error({ err, correlationId, clerkId }, "Provisioning failed");
    try { await db.execute(sql`INSERT INTO clerk_webhook_events (id,event_type,clerk_user_id,status,error) VALUES (${correlationId}, ${input.source}, ${clerkId}, 'failed', 'provisioning_failed') ON CONFLICT (id) DO UPDATE SET status='failed', error='provisioning_failed'`); } catch {
      // Best-effort failure bookkeeping must not mask the original error.
    }
    return { user: null, status: "failed", correlationId, error: "provisioning_failed" };
  }
}

export async function auditProvisioning(user: typeof usersTable.$inferSelect, action: string, correlationId: string, source: string): Promise<void> {
  try { await db.insert(auditLogsTable).values({ actorId: user.id, actorEmail: user.email ?? "", actorRole: user.role, tenantId: user.tenantId ?? null, action, resourceType: "user", resourceId: String(user.id), metadata: { correlationId, source }, ipAddress: null }); } catch (err) { logger.warn({ err, correlationId }, "Provisioning audit write failed"); }
}

export async function fetchAndProvisionClerkUser(clerkId: string, source: string, correlationId = makeCorrelationId("login")): Promise<ProvisioningResult> {
  const clerkUser = await clerkClient.users.getUser(clerkId) as unknown as ClerkProvisioningUser;
  return provisionVerifiedClerkUser({ clerkUser, source, correlationId, requireVerified: true });
}
