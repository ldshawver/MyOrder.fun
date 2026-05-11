import { EventEmitter } from "node:events";
import type { Response } from "express";
import { logger } from "./logger";

/**
 *
 * Event vocabulary matches the spec: `order.assigned`, `order.updated`,
 * `order.ready`. Every payload carries `customerId` and
 * `assignedCsrUserId` so the SERVER can enforce strict scoping before
 * write — clients are NOT trusted to filter.
 *
 * Authorization rules (enforced in `shouldDeliver`):
 *   admin / supervisor — see all events
 *   business_sitter — same scope as a CSR (own assignments + null queue)
 *   customer_service_rep / lab_tech / sales_rep
 *       — only events where assignedCsrUserId === self OR assignedCsrUserId === null
 *   user (customer)
 *       — only events where customerId === self
 */

export type OrderEventBase = {
  orderId: number;
  customerId: number;
  assignedCsrUserId: number | null;
};

export type OrderAssignedEvent = OrderEventBase & {
  type: "order.assigned";
  routeSource: string;
  customerName: string;
  total: number;
  itemCount: number;
  routedAt: string;
  estimatedReadyAt: string | null;
  promisedMinutes: number | null;
};

export type OrderUpdatedEvent = OrderEventBase & {
  type: "order.updated";
  fulfillmentStatus: string | null;
  status: string;
  estimatedReadyAt: string | null;
  acceptedAt: string | null;
  etaAdjustedBySupervisor: boolean;
  routeSource: string | null;
  /** Free-form change reason — eta_adjusted | accepted | reassigned | status_changed */
  reason: string;
};

export type OrderReadyEvent = OrderEventBase & {
  type: "order.ready";
  readyAt: string;
};

export type OrderEvent = OrderAssignedEvent | OrderUpdatedEvent | OrderReadyEvent;

const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Ring buffer of recent events for the SSE poll fallback. */
type StoredEvent = { at: string; ev: OrderEvent };
const RECENT_LIMIT = 200;
const recent: StoredEvent[] = [];

export function publishOrderEvent(ev: OrderEvent): void {
  recent.push({ at: new Date().toISOString(), ev });
  if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
  bus.emit("event", ev);
}

/**
 * Returns events newer than `sinceIso` that the given client is allowed to
 * see. Used by the /orders/recent-events endpoint when an EventSource
 * client falls back to short polling.
 */
export function getRecentEventsForClient(client: SseClient, sinceIso: string): OrderEvent[] {
  const since = new Date(sinceIso).getTime();
  return recent
    .filter(r => new Date(r.at).getTime() > since && shouldDeliver(client, r.ev))
    .map(r => r.ev);
}

export type SseClient = {
  res: Response;
  userId: number;
  role: string;
};

export function subscribe(client: SseClient): () => void {
  const handler = (ev: OrderEvent) => {
    if (!shouldDeliver(client, ev)) return;
    try {
      client.res.write(`event: ${ev.type}\n`);
      client.res.write(`data: ${JSON.stringify(ev)}\n\n`);
    } catch (err) {
      logger.warn({ err, userId: client.userId }, "SSE write failed");
    }
  };
  bus.on("event", handler);
  return () => bus.off("event", handler);
}

export function shouldDeliver(client: SseClient, ev: OrderEvent): boolean {
  const role = client.role;
  // Privileged roles see everything
  if (role === "admin" || role === "supervisor") {
    return true;
  }
  // CSR pool (and business_sitter helper) — only their own assigned orders
  // OR the unassigned general queue
  if (role === "customer_service_rep" || role === "lab_tech" || role === "sales_rep" || role === "business_sitter") {
    return ev.assignedCsrUserId === null || ev.assignedCsrUserId === client.userId;
  }
  // Customers — only their own orders
  if (role === "user") {
    return ev.customerId === client.userId;
  }
  return false;
}

// Test helper
export function _resetBus(): void {
  bus.removeAllListeners("event");
}
