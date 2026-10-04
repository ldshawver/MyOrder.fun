import { useCallback, useEffect, useRef, useState } from "react";

type Config = { enabled: boolean; mode: "disabled" | "sandbox" | "live"; clientId?: string; currency?: string };
type Eligible = { isEligible(method: string): boolean; getDetails?(method: string): { productCode?: string; countryCode?: string } };
type PresentationMode = "auto";
type WalletSession = { start(options: { presentationMode: PresentationMode }, order: Promise<{ orderId: string }>): Promise<void>; hasReturned?(): boolean; resume?(): Promise<void> };
type Method = "paypal" | "paylater" | "venmo" | "card";
type Sdk = {
  findEligibleMethods(options: { currencyCode: string }): Promise<Eligible>;
  createPayPalOneTimePaymentSession(options: { onApprove(data: { orderId: string }): Promise<void>; onCancel(): void; onError(error?: unknown): void }): WalletSession;
  createPayLaterOneTimePaymentSession?(options: { onApprove(data: { orderId: string }): Promise<void>; onCancel(): void; onError(error?: unknown): void }): WalletSession;
  createVenmoOneTimePaymentSession?(options: { onApprove(data: { orderId: string }): Promise<void>; onCancel(): void; onError(error?: unknown): void }): WalletSession;
  createPayPalGuestOneTimePaymentSession?(options: { onApprove(data: { orderId: string }): Promise<void>; onComplete(): void; onCancel(): void; onError(error?: unknown): void; onWarn(): void }): Promise<WalletSession>;
};
declare global { interface Window { paypal?: { createInstance(options: { clientId: string; components: string[]; pageType: "checkout" }): Promise<Sdk> } } }

type Props = {
  /** Existing pending checkout order, such as a recovery/payment-status page. */
  orderId?: number;
  /** Called only after the buyer presses a provider-controlled payment action. */
  createOrder?: () => Promise<number>;
  getToken: () => Promise<string | null>;
  onCaptured: (orderId: number) => void;
  onAbandoned?: (orderId: number) => void;
  disabled?: boolean;
};

const idempotencyKey = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
const pendingKey = "myorder-paypal-v6-pending";

/**
 * PayPal JavaScript SDK v6 Wallet checkout.  The browser receives only the
 * publishable client ID.  Advanced Card Fields deliberately stay hidden until
 * the merchant's v6 eligibility and hosted-fields integration are confirmed.
 */
export function PayPalCheckoutButton({ orderId, createOrder, getToken, onCaptured, onAbandoned, disabled = false }: Props) {
  const walletContainer = useRef<HTMLDivElement>(null);
  const internalOrderId = useRef<number | undefined>(orderId);
  const sessions = useRef<Partial<Record<Method, WalletSession>>>({}); const attempt = useRef<{ id: number; providerOrderId: string } | undefined>(undefined);
  const busyRef = useRef(false);
  const [walletEligible, setWalletEligible] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null);

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => { const token = await getToken(); return token ? { Authorization: `Bearer ${token}` } : {}; }, [getToken]);
  const resolveInternalOrder = useCallback(async () => {
    if (internalOrderId.current) return internalOrderId.current;
    if (!createOrder) throw new Error("Checkout order is not ready");
    const created = await createOrder(); internalOrderId.current = created; return created;
  }, [createOrder]);
  const createProviderOrder = useCallback(async () => {
    if (attempt.current) return attempt.current;
    const checkoutOrderId = await resolveInternalOrder();
    const response = await fetch(`/api/payments/paypal/orders/${checkoutOrderId}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey(`paypal-create-${checkoutOrderId}`), ...await authHeaders() }, body: "{}" });
    const body = await response.json() as { attemptId?: number; providerOrderId?: string; error?: string };
    if (!response.ok || !body.attemptId || !body.providerOrderId) throw new Error(body.error ?? "Could not create PayPal order");
    attempt.current = { id: body.attemptId, providerOrderId: body.providerOrderId };
    sessionStorage.setItem(pendingKey, JSON.stringify({ orderId: checkoutOrderId, ...attempt.current }));
    return attempt.current;
  }, [authHeaders, resolveInternalOrder]);
  const capture = useCallback(async (providerOrderId: string) => {
    const current = attempt.current; const checkoutOrderId = await resolveInternalOrder();
    if (!current || current.providerOrderId !== providerOrderId) throw new Error("Payment attempt mismatch");
    const response = await fetch(`/api/payments/paypal/orders/${checkoutOrderId}/capture`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `paypal-capture-${checkoutOrderId}-${providerOrderId}`, ...await authHeaders() }, body: JSON.stringify({ attemptId: current.id }) });
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error ?? "PayPal capture requires reconciliation");
    sessionStorage.removeItem(pendingKey);
    setMessage("PayPal payment captured and verified."); onCaptured(checkoutOrderId);
  }, [authHeaders, onCaptured, resolveInternalOrder]);
  const cancelAfterBuyerCancellation = useCallback(async () => {
    const checkoutOrderId = internalOrderId.current;
    if (!checkoutOrderId) return;
    try {
      const response = await fetch(`/api/orders/${checkoutOrderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...await authHeaders() },
        body: JSON.stringify({ status: "cancelled", reason: "Buyer cancelled PayPal approval" }),
      });
      if (!response.ok) throw new Error("Checkout cancellation needs review");
      // The provider session has explicitly reported buyer cancellation. The
      // existing order lifecycle releases its unpaid reservation atomically.
      // A new click therefore starts a new, server-validated checkout rather
      // than attaching to a cancelled order.
      const abandonedOrderId = checkoutOrderId;
      internalOrderId.current = undefined; attempt.current = undefined; sessionStorage.removeItem(pendingKey);
      onAbandoned?.(abandonedOrderId);
      setMessage("PayPal approval was canceled. Your cart is unchanged and no payment was captured.");
    } catch {
      // Do not discard a pending provider identity if local cancellation did
      // not complete. It remains recoverable and cannot be silently retried.
      setMessage("PayPal approval was canceled, but checkout recovery is still pending. Do not retry payment until the order status is confirmed.");
    }
  }, [authHeaders, onAbandoned]);
  const startWallet = useCallback(async (method: Method) => {
    const session = sessions.current[method];
    if (busyRef.current || disabled || !session) return;
    busyRef.current = true; setBusy(true); setMessage(null);
    try {
      const providerOrder = createProviderOrder().then(row => ({ orderId: row.providerOrderId }));
      // PayPal selects popup, modal, or redirect as appropriate. Do not try a
      // second presentation mode after an ambiguous provider outcome.
      await session.start({ presentationMode: "auto" }, providerOrder);
    } catch { setMessage("PayPal checkout could not start; no payment was confirmed."); }
    finally { busyRef.current = false; setBusy(false); }
  }, [createProviderOrder, disabled]);

  useEffect(() => {
    let disposed = false;
    async function start() {
      const configResponse = await fetch("/api/payments/config", { headers: await authHeaders(), credentials: "same-origin", cache: "no-store" });
      const config = await configResponse.json() as Config;
      if (!configResponse.ok || !config.enabled || !config.clientId) {
        setWalletEligible(false);
        setMessage("PayPal checkout is unavailable because live payment configuration is incomplete.");
        return;
      }
      let script = document.querySelector<HTMLScriptElement>('script[data-myorder-paypal-sdk="v6"]');
      if (!script) { script = document.createElement("script"); script.dataset.myorderPaypalSdk = "v6"; script.src = config.mode === "sandbox" ? "https://www.sandbox.paypal.com/web-sdk/v6/core" : "https://www.paypal.com/web-sdk/v6/core"; script.async = true; document.head.appendChild(script); }
      if (!window.paypal) await new Promise<void>((resolve, reject) => { script!.addEventListener("load", () => resolve(), { once: true }); script!.addEventListener("error", () => reject(new Error("PayPal SDK unavailable")), { once: true }); });
      if (disposed || !window.paypal) return;
      const sdk = await window.paypal.createInstance({ clientId: config.clientId, components: ["paypal-payments", "venmo-payments", "paypal-guest-payments"], pageType: "checkout" });
      const methods = await sdk.findEligibleMethods({ currencyCode: config.currency ?? "USD" });
      if (disposed) return;
      const options = { onApprove: (data: { orderId: string }) => capture(data.orderId), onCancel: () => { void cancelAfterBuyerCancellation(); }, onError: () => setMessage("PayPal reported an error. Checkout remains pending for safe recovery; do not retry automatically.") };
      const supported: Array<{ method: Method; tag: string; label: string; create: () => WalletSession | Promise<WalletSession> | undefined }> = [
        { method: "paypal", tag: "paypal-button", label: "Pay with PayPal", create: () => sdk.createPayPalOneTimePaymentSession(options) },
        { method: "paylater", tag: "paypal-pay-later-button", label: "Pay Later", create: () => sdk.createPayLaterOneTimePaymentSession?.(options) },
        { method: "venmo", tag: "venmo-button", label: "Pay with Venmo", create: () => sdk.createVenmoOneTimePaymentSession?.(options) },
        { method: "card", tag: "paypal-basic-card-button", label: "Pay with card", create: () => sdk.createPayPalGuestOneTimePaymentSession?.({ ...options, onComplete: () => {}, onWarn: () => setMessage("Please complete the card form in PayPal's secure window.") }) },
      ];
      const container = walletContainer.current;
      container?.replaceChildren();
      let eligibleCount = 0;
      for (const method of supported) {
        if (!container || !methods.isEligible(method.method)) continue;
        const session = await method.create();
        if (!session) continue;
        sessions.current[method.method] = session;
        const button = document.createElement(method.tag);
        button.setAttribute("type", "pay"); button.setAttribute("aria-label", method.label);
        if (method.method === "paypal") button.dataset.testid = "paypal-button";
        if (method.method === "paylater") {
          const details = methods.getDetails?.("paylater");
          if (!details?.productCode || !details.countryCode) continue;
          Object.assign(button, { productCode: details.productCode, countryCode: details.countryCode });
        }
        button.addEventListener("click", () => { void startWallet(method.method); });
        if (method.method === "card") {
          const wrapper = document.createElement("paypal-basic-card-container");
          wrapper.appendChild(button); container.appendChild(wrapper);
        } else container.appendChild(button);
        eligibleCount++;
      }
      setWalletEligible(eligibleCount > 0);
      const returned = Object.values(sessions.current).find(session => session?.hasReturned?.());
      if (returned?.resume) {
        try {
          const pending = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null") as { orderId?: number; id?: number; providerOrderId?: string } | null;
          if (!pending || !Number.isSafeInteger(pending.orderId) || !Number.isSafeInteger(pending.id) || !/^[A-Za-z0-9_-]{1,150}$/.test(pending.providerOrderId ?? "")) throw new Error("Missing checkout identity");
          internalOrderId.current = pending.orderId; attempt.current = { id: pending.id!, providerOrderId: pending.providerOrderId! };
          await returned.resume();
        } catch { setMessage("PayPal return needs order recovery. Do not start another payment until the order is checked."); }
      }
    }
    start().catch(() => { if (!disposed) { setWalletEligible(false); setMessage("Online PayPal checkout is unavailable."); } });
    return () => { disposed = true; };
  }, [authHeaders, cancelAfterBuyerCancellation, capture, startWallet]);

  return <div className="space-y-3" aria-busy={busy}>
    <div ref={walletContainer} data-testid="paypal-wallet-container" aria-label="PayPal Wallet" />
    {walletEligible === null && <p className="text-xs text-muted-foreground">Loading secure PayPal checkout…</p>}
    {walletEligible === false && <p className="text-xs text-muted-foreground">PayPal Wallet is unavailable for this account or session.</p>}
    {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
  </div>;
}
