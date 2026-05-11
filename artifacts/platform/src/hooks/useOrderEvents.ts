import { useEffect, useRef } from "react";

/**
 *
 * Server emits exactly three event names: `order.assigned`, `order.updated`,
 * `order.ready`. Server-side scoping ensures each subscriber only receives
 * events they're authorized to see (admins/supervisors see all; CSRs see
 * their own assignments + the General Account null queue; customers see
 * only their own orders).
 */
export type OrderEvent =
  | {
      type: "order.assigned";
      orderId: number;
      customerId: number;
      assignedCsrUserId: number | null;
      routeSource: string;
      customerName: string;
      total: number;
      itemCount: number;
      routedAt: string;
      estimatedReadyAt: string | null;
      promisedMinutes: number | null;
    }
  | {
      type: "order.updated";
      orderId: number;
      customerId: number;
      assignedCsrUserId: number | null;
      fulfillmentStatus: string | null;
      status: string;
      estimatedReadyAt: string | null;
      acceptedAt: string | null;
      etaAdjustedBySupervisor: boolean;
      routeSource: string | null;
      reason: string;
    }
  | {
      type: "order.ready";
      orderId: number;
      customerId: number;
      assignedCsrUserId: number | null;
      readyAt: string;
    };

type Options = {
  /** Polling interval (ms) used as a fallback if the SSE connection drops. */
  fallbackPollMs?: number;
  /** Optional callback invoked when SSE drops and we switch to polling. */
  onFallback?: () => void;
};

/**
 * Subscribe to /api/orders/stream. Auth flows via the Clerk session cookie
 * because EventSource cannot send Authorization headers.
 *
 * If the SSE connection drops (network, proxy idle timeout, etc.), the hook
 * automatically falls back to short polling every `fallbackPollMs` (default
 * 10s) by hitting /api/orders/recent-events and re-emitting any events we
 * have not yet seen. This guarantees realtime UI keeps working even when
 * SSE is blocked.
 */
export function useOrderEvents(
  onEvent: (ev: OrderEvent) => void,
  enabled = true,
  options: Options = {},
): void {
  const { fallbackPollMs = 10_000, onFallback } = options;
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let lastSeenAt = new Date().toISOString();
    let reconnectAttempts = 0;

    const startPolling = () => {
      if (pollTimer) return;
      onFallback?.();
      pollTimer = setInterval(async () => {
        try {
          const r = await fetch(`/api/orders/recent-events?since=${encodeURIComponent(lastSeenAt)}`, {
            credentials: "include",
          });
          if (!r.ok) return;
          const body = (await r.json()) as { events: OrderEvent[]; serverTime?: string };
          for (const ev of body.events ?? []) handlerRef.current(ev);
          if (body.serverTime) lastSeenAt = body.serverTime;
        } catch { /* keep trying */ }
      }, fallbackPollMs);
    };

    const stopPolling = () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };

    const connect = (): EventSource => {
      const es = new EventSource("/api/orders/stream", { withCredentials: true });
      const eventTypes: OrderEvent["type"][] = ["order.assigned", "order.updated", "order.ready"];
      const listeners = eventTypes.map(type => {
        const fn = (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data) as OrderEvent;
            handlerRef.current(data);
            lastSeenAt = new Date().toISOString();
          } catch { /* ignore malformed */ }
        };
        es.addEventListener(type, fn as EventListener);
        return { type, fn };
      });
      es.onopen = () => {
        reconnectAttempts = 0;
        stopPolling();
      };
      es.onerror = () => {
        // Browser will auto-reconnect; if it keeps failing we switch to poll fallback
        reconnectAttempts++;
        if (reconnectAttempts >= 2) startPolling();
      };
      (es as unknown as { _listeners: typeof listeners })._listeners = listeners;
      return es;
    };

    const es = connect();
    return () => {
      stopPolling();
      const listeners = (es as unknown as { _listeners: Array<{ type: string; fn: EventListener }> })._listeners;
      for (const { type, fn } of listeners) es.removeEventListener(type, fn);
      es.close();
    };
  }, [enabled, fallbackPollMs, onFallback]);
}
