import { useCallback, useEffect, useRef, useState } from "react";

type Config = { enabled: boolean; mode: "disabled" | "sandbox" | "live"; currency?: string };
type Eligible = { isEligible(method: string): boolean };
type PaymentResult = { state: string; data?: { orderId?: string; message?: string } };
type WalletSession = { start(options: { presentationMode: "auto" }, order: Promise<{ orderId: string }>): Promise<void> };
type CardSession = { createCardFieldsComponent(options: { type: "number" | "expiry" | "cvv"; placeholder: string }): Node; submit(orderId: string, options: Record<string, unknown>): Promise<PaymentResult> };
type Sdk = {
  findEligibleMethods(options: { currencyCode: string }): Promise<Eligible>;
  createPayPalOneTimePaymentSession(options: { onApprove(data: { orderId: string }): Promise<void>; onCancel(): void; onError(): void }): WalletSession;
  createCardFieldsOneTimePaymentSession(): CardSession;
};
declare global { interface Window { paypal?: { createInstance(options: { clientToken: string; components: string[]; pageType: "checkout" }): Promise<Sdk> } } }

const key = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;

export function PayPalCheckoutButton({ orderId, getToken, onCaptured }: { orderId: number; getToken: () => Promise<string | null>; onCaptured: () => void }) {
  const number = useRef<HTMLDivElement>(null); const expiry = useRef<HTMLDivElement>(null); const cvv = useRef<HTMLDivElement>(null);
  const wallet = useRef<WalletSession | undefined>(undefined); const card = useRef<CardSession | undefined>(undefined); const [cardEligible, setCardEligible] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null); const attempt = useRef<{ id: number; providerOrderId: string } | undefined>(undefined);

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => { const token = await getToken(); return token ? { Authorization: `Bearer ${token}` } : {}; }, [getToken]);
  const createProviderOrder = useCallback(async () => {
    if (attempt.current) return attempt.current;
    const response = await fetch(`/api/payments/paypal/orders/${orderId}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key(`paypal-create-${orderId}`), ...await authHeaders() }, body: "{}" });
    const body = await response.json() as { attemptId?: number; providerOrderId?: string; error?: string };
    if (!response.ok || !body.attemptId || !body.providerOrderId) throw new Error(body.error ?? "Could not create PayPal order");
    return attempt.current = { id: body.attemptId, providerOrderId: body.providerOrderId };
  }, [authHeaders, orderId]);
  const capture = useCallback(async (providerOrderId: string) => {
    const current = attempt.current; if (!current || current.providerOrderId !== providerOrderId) throw new Error("Payment attempt mismatch");
    const response = await fetch(`/api/payments/paypal/orders/${orderId}/capture`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `paypal-capture-${orderId}-${providerOrderId}`, ...await authHeaders() }, body: JSON.stringify({ attemptId: current.id }) });
    const body = await response.json() as { error?: string }; if (!response.ok) throw new Error(body.error ?? "PayPal capture requires reconciliation");
    setMessage("PayPal Sandbox payment captured and verified."); onCaptured();
  }, [authHeaders, onCaptured, orderId]);

  useEffect(() => {
    let disposed = false; let script: HTMLScriptElement | undefined;
    async function start() {
      const config = await fetch("/api/payments/config", { credentials: "same-origin" }).then(r => r.json()) as Config;
      if (!config.enabled) { setMessage("Online PayPal checkout is disabled."); return; }
      const tokenResponse = await fetch("/api/payments/paypal/browser-token", { headers: await authHeaders(), credentials: "same-origin" });
      const token = await tokenResponse.json() as { accessToken?: string };
      if (!tokenResponse.ok || !token.accessToken) throw new Error("PayPal browser token unavailable");
      script = document.createElement("script"); script.src = config.mode === "sandbox" ? "https://www.sandbox.paypal.com/web-sdk/v6/core" : "https://www.paypal.com/web-sdk/v6/core"; script.async = true;
      await new Promise<void>((resolve, reject) => { script!.onload = () => resolve(); script!.onerror = () => reject(new Error("PayPal SDK unavailable")); document.head.appendChild(script!); });
      if (disposed || !window.paypal) return;
      const sdk = await window.paypal.createInstance({ clientToken: token.accessToken, components: ["paypal-payments", "card-fields"], pageType: "checkout" });
      const methods = await sdk.findEligibleMethods({ currencyCode: config.currency ?? "USD" });
      if (methods.isEligible("paypal")) wallet.current = sdk.createPayPalOneTimePaymentSession({ onApprove: data => capture(data.orderId), onCancel: () => setMessage("PayPal approval was canceled; no capture occurred."), onError: () => setMessage("PayPal checkout failed; no payment was confirmed.") });
      const eligible = methods.isEligible("advanced_cards"); setCardEligible(eligible);
      if (eligible && number.current && expiry.current && cvv.current) {
        card.current = sdk.createCardFieldsOneTimePaymentSession();
        number.current.replaceChildren(card.current.createCardFieldsComponent({ type: "number", placeholder: "Card number" }));
        expiry.current.replaceChildren(card.current.createCardFieldsComponent({ type: "expiry", placeholder: "MM/YY" }));
        cvv.current.replaceChildren(card.current.createCardFieldsComponent({ type: "cvv", placeholder: "CVV" }));
      }
    }
    start().catch(() => { if (!disposed) { setCardEligible(false); setMessage("Online PayPal checkout is unavailable."); } });
    return () => { disposed = true; script?.remove(); };
  }, [authHeaders, capture]);

  async function payWallet() { if (busy || !wallet.current) return; setBusy(true); setMessage(null); try { await wallet.current.start({ presentationMode: "auto" }, createProviderOrder().then(row => ({ orderId: row.providerOrderId }))); } catch { setMessage("PayPal checkout could not start; no payment was confirmed."); } finally { setBusy(false); } }
  async function payCard() { if (busy || !card.current) return; setBusy(true); setMessage(null); try { const current = await createProviderOrder(); const result = await card.current.submit(current.providerOrderId, {}); if (result.state !== "succeeded" || !result.data?.orderId) throw new Error(result.data?.message ?? "Card authorization failed"); await capture(result.data.orderId); } catch { setMessage("PayPal-hosted card payment failed; no payment was confirmed."); } finally { setBusy(false); } }

  return <div className="space-y-3">
    <button type="button" disabled={busy || !wallet.current} onClick={() => void payWallet()} className="w-full rounded-xl border px-4 py-2.5 text-sm font-semibold" data-testid="button-paypal">Pay with PayPal</button>
    {cardEligible ? <div className="space-y-2" data-testid="paypal-card-fields"><div ref={number} className="h-12 rounded border" /><div className="grid grid-cols-2 gap-2"><div ref={expiry} className="h-12 rounded border" /><div ref={cvv} className="h-12 rounded border" /></div><button type="button" disabled={busy} onClick={() => void payCard()} className="w-full rounded-xl border px-4 py-2.5 text-sm font-semibold" data-testid="button-paypal-card">Pay by card through PayPal</button></div> : cardEligible === false ? <p className="text-xs text-muted-foreground">PayPal has not confirmed Advanced Credit and Debit Card eligibility for this account/session. Card entry is unavailable.</p> : null}
    {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
  </div>;
}
