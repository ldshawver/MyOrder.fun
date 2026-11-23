import { and, eq } from "drizzle-orm";
import {
  cjFulfillmentEventsTable,
  cjOrderFulfillmentsTable,
  db,
  orderFulfillmentGroupsTable,
  ordersTable,
} from "@workspace/db";
import { decideCjEventTransition, type CjProviderEvent } from "./cjFulfillmentEvents";
import { deriveParentFulfillmentStatus } from "./fulfillmentGroupLifecycle";
import type { OrderLifecycleState } from "./orderStateMachine";

export class CjFulfillmentEventError extends Error {
  constructor(public readonly code: "FULFILLMENT_NOT_FOUND" | "EVENT_PAYLOAD_MISMATCH") {
    super(code);
  }
}

export async function processAuthenticatedCjFulfillmentEvent(input: {
  tenantId: number;
  event: CjProviderEvent;
  payloadSha256: string;
}): Promise<{ replayed: boolean; reconciliationRequired: boolean }> {
  return db.transaction(async (tx) => {
    const [fulfillment] = await tx.select().from(cjOrderFulfillmentsTable).where(and(
      eq(cjOrderFulfillmentsTable.tenantId, input.tenantId),
      eq(cjOrderFulfillmentsTable.providerOrderId, input.event.providerOrderId),
    )).for("update").limit(1);
    if (!fulfillment) throw new CjFulfillmentEventError("FULFILLMENT_NOT_FOUND");

    const inserted = await tx.insert(cjFulfillmentEventsTable).values({
      tenantId: input.tenantId,
      fulfillmentId: fulfillment.id,
      providerEventId: input.event.eventId,
      eventType: input.event.eventType,
      providerOrderId: input.event.providerOrderId,
      providerStatus: input.event.status,
      payloadSha256: input.payloadSha256,
      providerEventAt: input.event.occurredAt,
    }).onConflictDoNothing().returning({ id: cjFulfillmentEventsTable.id });

    if (!inserted.length) {
      const [existing] = await tx.select({ payloadSha256: cjFulfillmentEventsTable.payloadSha256 })
        .from(cjFulfillmentEventsTable).where(and(
          eq(cjFulfillmentEventsTable.tenantId, input.tenantId),
          eq(cjFulfillmentEventsTable.providerEventId, input.event.eventId),
        )).limit(1);
      if (!existing || existing.payloadSha256 !== input.payloadSha256) {
        throw new CjFulfillmentEventError("EVENT_PAYLOAD_MISMATCH");
      }
      return { replayed: true, reconciliationRequired: fulfillment.reconciliationState === "reconciliation_required" };
    }

    const decision = decideCjEventTransition({
      currentProviderStatus: fulfillment.providerStatus as Parameters<typeof decideCjEventTransition>[0]["currentProviderStatus"],
      incomingProviderStatus: input.event.status,
      lastProviderEventAt: fulfillment.lastProviderEventAt,
      incomingProviderEventAt: input.event.occurredAt,
    });
    const now = new Date();
    const reconciliationRequired = decision.action === "reconcile" ||
      (decision.action === "apply" && decision.groupStatus === "reconciliation_required");

    if (decision.action === "apply") {
      await tx.update(cjOrderFulfillmentsTable).set({
        providerStatus: decision.providerStatus,
        reconciliationState: reconciliationRequired ? "reconciliation_required" : "in_sync",
        lastProviderEventAt: input.event.occurredAt ?? fulfillment.lastProviderEventAt,
        updatedAt: now,
      }).where(and(eq(cjOrderFulfillmentsTable.tenantId, input.tenantId), eq(cjOrderFulfillmentsTable.id, fulfillment.id)));
      await tx.update(orderFulfillmentGroupsTable).set({ status: decision.groupStatus, updatedAt: now }).where(and(
        eq(orderFulfillmentGroupsTable.tenantId, input.tenantId),
        eq(orderFulfillmentGroupsTable.orderId, fulfillment.orderId),
        eq(orderFulfillmentGroupsTable.id, fulfillment.fulfillmentGroupId),
        eq(orderFulfillmentGroupsTable.provider, "cj"),
      ));
    } else if (decision.action === "reconcile") {
      await tx.update(cjOrderFulfillmentsTable).set({ reconciliationState: "reconciliation_required", updatedAt: now })
        .where(and(eq(cjOrderFulfillmentsTable.tenantId, input.tenantId), eq(cjOrderFulfillmentsTable.id, fulfillment.id)));
      await tx.update(orderFulfillmentGroupsTable).set({ status: "reconciliation_required", updatedAt: now }).where(and(
        eq(orderFulfillmentGroupsTable.tenantId, input.tenantId),
        eq(orderFulfillmentGroupsTable.orderId, fulfillment.orderId),
        eq(orderFulfillmentGroupsTable.id, fulfillment.fulfillmentGroupId),
        eq(orderFulfillmentGroupsTable.provider, "cj"),
      ));
    }

    const groups = await tx.select({ status: orderFulfillmentGroupsTable.status }).from(orderFulfillmentGroupsTable).where(and(
      eq(orderFulfillmentGroupsTable.tenantId, input.tenantId),
      eq(orderFulfillmentGroupsTable.orderId, fulfillment.orderId),
    ));
    const parentStatus = deriveParentFulfillmentStatus(groups.map((row) => row.status as OrderLifecycleState));
    await tx.update(ordersTable).set({ fulfillmentStatus: parentStatus, updatedAt: now }).where(and(
      eq(ordersTable.tenantId, input.tenantId), eq(ordersTable.id, fulfillment.orderId),
    ));
    await tx.update(cjFulfillmentEventsTable).set({ processedAt: now }).where(and(
      eq(cjFulfillmentEventsTable.tenantId, input.tenantId), eq(cjFulfillmentEventsTable.id, inserted[0]!.id),
    ));
    return { replayed: false, reconciliationRequired };
  });
}
