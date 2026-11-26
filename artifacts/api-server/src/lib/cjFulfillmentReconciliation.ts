import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { adminSettingsTable, cjOrderFulfillmentsTable, db } from "@workspace/db";
import { safeDecrypt } from "./crypto";
import { processAuthenticatedCjFulfillmentEvent } from "./cjFulfillmentEventProcessor";
import { fetchWooSafely } from "./wooSafeHttp";

const MAX_RECONCILIATION_BATCH = 25;

const ProviderOrderSnapshot = z.object({
  id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^[1-9][0-9]{0,19}$/)),
  status: z.enum(["pending", "processing", "on-hold", "completed", "cancelled", "failed", "refunded"]),
  date_modified_gmt: z.string().datetime({ local: true }),
}).passthrough();

export type CjPollingAdapter = (providerOrderId: string) => Promise<unknown>;

export async function createTenantCjPollingAdapter(tenantId: number): Promise<CjPollingAdapter> {
  const [settings] = await db.select({
    enabled: adminSettingsTable.wcEnabled,
    storeUrl: adminSettingsTable.wcStoreUrl,
    consumerKey: adminSettingsTable.wcConsumerKey,
    consumerSecret: adminSettingsTable.wcConsumerSecret,
  }).from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, tenantId)).limit(1);
  const consumerKey = safeDecrypt(settings?.consumerKey);
  const consumerSecret = safeDecrypt(settings?.consumerSecret);
  if (settings?.enabled === false || !settings?.storeUrl?.trim() || !consumerKey || !consumerSecret) {
    throw new Error("CJ provider polling is not configured for this tenant");
  }
  const storeUrl = settings.storeUrl.trim();
  return async (providerOrderId) => {
    if (!/^[1-9][0-9]{0,19}$/.test(providerOrderId)) throw new Error("Invalid CJ provider identity");
    const response = await fetchWooSafely(storeUrl, `/wp-json/wc/v3/orders/${providerOrderId}`, consumerKey, consumerSecret);
    if (!response.ok) throw new Error(`CJ provider polling failed (${response.status})`);
    return response.json();
  };
}

export function parseCjPollingSnapshot(input: unknown): {
  providerOrderId: string;
  status: "pending" | "processing" | "on_hold" | "completed" | "cancelled" | "failed" | "refunded";
  occurredAt: Date;
} {
  const snapshot = ProviderOrderSnapshot.parse(input);
  return {
    providerOrderId: snapshot.id,
    status: snapshot.status === "on-hold" ? "on_hold" : snapshot.status,
    occurredAt: new Date(`${snapshot.date_modified_gmt}Z`),
  };
}

/**
 * Poll a bounded, tenant-scoped set of provider-owned CJ fulfillments. This is
 * deliberately a server service rather than a staff transition endpoint: the
 * provider snapshot must pass through the same durable event policy as a
 * signed webhook before it can change a group or its parent order.
 */
export async function reconcileCjFulfillments(input: {
  tenantId: number;
  poll: CjPollingAdapter;
  limit?: number;
}): Promise<{ attempted: number; reconciled: number; failed: number }> {
  const limit = Math.min(MAX_RECONCILIATION_BATCH, Math.max(1, input.limit ?? MAX_RECONCILIATION_BATCH));
  const candidates = await db.select({
    id: cjOrderFulfillmentsTable.id,
    providerOrderId: cjOrderFulfillmentsTable.providerOrderId,
  }).from(cjOrderFulfillmentsTable).where(and(
    eq(cjOrderFulfillmentsTable.tenantId, input.tenantId),
    inArray(cjOrderFulfillmentsTable.reconciliationState, ["pending", "reconciliation_required"]),
  )).orderBy(asc(cjOrderFulfillmentsTable.updatedAt)).limit(limit);

  let reconciled = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const snapshot = parseCjPollingSnapshot(await input.poll(candidate.providerOrderId));
      if (snapshot.providerOrderId !== candidate.providerOrderId) throw new Error("CJ provider identity mismatch");
      const eventId = `poll:${candidate.id}:${snapshot.occurredAt.toISOString()}:${snapshot.status}`;
      const payloadSha256 = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      await processAuthenticatedCjFulfillmentEvent({
        tenantId: input.tenantId,
        event: { eventId, eventType: "provider.poll", ...snapshot },
        payloadSha256,
      });
      await db.update(cjOrderFulfillmentsTable).set({ lastReconciledAt: new Date() }).where(and(
        eq(cjOrderFulfillmentsTable.tenantId, input.tenantId),
        eq(cjOrderFulfillmentsTable.id, candidate.id),
      ));
      reconciled += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: candidates.length, reconciled, failed };
}

export async function reconcileConfiguredCjFulfillments(tenantId: number, limit?: number) {
  const poll = await createTenantCjPollingAdapter(tenantId);
  return reconcileCjFulfillments({ tenantId, poll, limit });
}
