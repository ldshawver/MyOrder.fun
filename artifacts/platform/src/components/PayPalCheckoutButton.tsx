import { useEffect, useRef, useState } from "react";

type PayPalConfig = { enabled: boolean; provider: "paypal"; mode: "disabled" | "sandbox" | "live"; clientId?: string; currency?: string };
type PayPalButtons = { render(element: HTMLElement): Promise<void>; close?: () => void };
type PayPalNamespace = { Buttons(options: { createOrder(): Promise<string>; onApprove(data: { orderID: string }): Promise<void>; onCancel(): void; onError(): void }): PayPalButtons };

declare global { interface Window { paypal?: PayPalNamespace } }

function nonce(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }

export function PayPalCheckoutButton({ orderId, getToken, onCaptured }: { orderId: number; getToken: () => Promise<string | null>; onCaptured: () => void }) {
  const container = useRef<HTMLDivElement>(null); const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false; let buttons: PayPalButtons | undefined; let script: HTMLScriptElement | undefined; let attemptId: number | undefined;
    async function start() {
      const configResponse = await fetch("/api/payments/config", { credentials: "same-origin" });
      const config = await configResponse.json() as PayPalConfig;
      if (!config.enabled || !config.clientId || !container.current) return;
      script = document.createElement("script"); script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.clientId)}&currency=${encodeURIComponent(config.currency ?? "USD")}&intent=capture`;
      script.async = true; script.dataset.myorderPaypal = "true";
      await new Promise<void>((resolve, reject) => { script!.onload = () => resolve(); script!.onerror = () => reject(new Error("PayPal checkout failed to load")); document.head.appendChild(script!); });
      if (disposed || !window.paypal || !container.current) return;
      buttons = window.paypal.Buttons({
        async createOrder() {
          const token = await getToken(); const response = await fetch(`/api/payments/paypal/orders/${orderId}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": nonce(`paypal-create-${orderId}`), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: "{}" });
          const body = await response.json() as { attemptId?: number; providerOrderId?: string; error?: string };
          if (!response.ok || !body.attemptId || !body.providerOrderId) throw new Error(body.error ?? "Could not create PayPal checkout"); attemptId = body.attemptId; return body.providerOrderId;
        },
        async onApprove(data) {
          if (!attemptId) throw new Error("Missing local payment attempt"); const token = await getToken(); const response = await fetch(`/api/payments/paypal/orders/${orderId}/capture`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `paypal-capture-${orderId}-${data.orderID}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ attemptId }) });
          const body = await response.json() as { error?: string }; if (!response.ok) throw new Error(body.error ?? "PayPal capture requires reconciliation"); setMessage("PayPal payment captured."); onCaptured();
        },
        onCancel() { setMessage("PayPal approval was canceled. No payment was captured."); },
        onError() { setMessage("PayPal checkout could not be completed. No payment was confirmed."); },
      });
      await buttons.render(container.current);
    }
    start().catch(() => { if (!disposed) setMessage("Online PayPal checkout is unavailable."); });
    return () => { disposed = true; buttons?.close?.(); script?.remove(); };
  }, [getToken, onCaptured, orderId]);
  return <div className="space-y-2"><div ref={container} data-testid="button-paypal" aria-label="Pay securely with PayPal" />{message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}</div>;
}
