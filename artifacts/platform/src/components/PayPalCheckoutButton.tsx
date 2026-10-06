import { useCallback, useEffect, useRef, useState } from "react";

type Config = { enabled: boolean; mode: "disabled" | "sandbox" | "live"; clientId?: string; currency?: string; countryCode?: string };
type Eligible = { isEligible(method: string): boolean; getDetails?(method: string): { productCode?: string; countryCode?: string; config?: unknown } };
type PresentationMode = "auto";
type WalletSession = { start(options: { presentationMode: PresentationMode }, order: Promise<{ orderId: string }>): Promise<void>; hasReturned?(): boolean; resume?(): Promise<void> };
type Method = "paypal" | "paylater" | "venmo" | "card";
type WalletOrderInfo = { amount: string; currency: string; countryCode: string };
type ApplePaySessionApi = {
  config(): Promise<{ merchantCapabilities: string[]; supportedNetworks: string[] }>;
  validateMerchant(options: { validationUrl: string }): Promise<{ merchantSession: unknown }>;
  confirmOrder(options: { orderId: string; token: unknown; billingContact?: unknown; shippingContact?: unknown }): Promise<{ status?: string }>;
};
type GooglePaySessionApi = {
  formatConfigForPaymentRequest(config: unknown): Record<string, unknown> & { allowedPaymentMethods: unknown[]; apiVersion: number; apiVersionMinor: number; countryCode: string };
  confirmOrder(options: { orderId: string; paymentMethodData: unknown }): Promise<{ status?: string }>;
};
type GooglePaymentsClient = {
  isReadyToPay(request: { allowedPaymentMethods: unknown[]; apiVersion: number; apiVersionMinor: number }): Promise<{ result?: boolean }>;
  createButton(options: { onClick(): void }): HTMLElement;
  loadPaymentData(request: Record<string, unknown>): Promise<void>;
};
type ApplePayPayment = { token: unknown; billingContact?: unknown; shippingContact?: unknown };
type ApplePaySessionInstance = {
  onvalidatemerchant: ((event: { validationURL: string }) => void) | null;
  onpaymentauthorized: ((event: { payment: ApplePayPayment }) => void) | null;
  oncancel: (() => void) | null;
  begin(): void;
  abort(): void;
  completeMerchantValidation(session: unknown): void;
  completePayment(result: { status: number }): void;
};
type ApplePaySessionConstructor = {
  new(version: number, request: Record<string, unknown>): ApplePaySessionInstance;
  canMakePayments(): boolean;
  STATUS_SUCCESS: number;
  STATUS_FAILURE: number;
};
type Sdk = {
  findEligibleMethods(options: { currencyCode: string; amount?: string; countryCode?: string }): Promise<Eligible>;
  createPayPalOneTimePaymentSession(options: { onApprove(data: { orderId: string }): Promise<void>; onCancel(): void; onError(error?: unknown): void }): WalletSession;
  createPayLaterOneTimePaymentSession?(options: { onApprove(data: { orderId: string }): Promise<void>; onCancel(): void; onError(error?: unknown): void }): WalletSession;
  createVenmoOneTimePaymentSession?(options: { onApprove(data: { orderId: string }): Promise<void>; onCancel(): void; onError(error?: unknown): void }): WalletSession;
  createPayPalGuestOneTimePaymentSession?(options: { onApprove(data: { orderId: string }): Promise<void>; onComplete(): void; onCancel(): void; onError(error?: unknown): void; onWarn(): void }): Promise<WalletSession>;
  createApplePayOneTimePaymentSession?(): Promise<ApplePaySessionApi>;
  createGooglePayOneTimePaymentSession?(): GooglePaySessionApi;
};
declare global {
  interface Window {
    paypal?: { createInstance(options: { clientId: string; components: string[]; pageType: "checkout" }): Promise<Sdk> };
    ApplePaySession?: ApplePaySessionConstructor;
    google?: { payments?: { api?: { PaymentsClient: new(options: { environment: "TEST" | "PRODUCTION"; paymentDataCallbacks: { onPaymentAuthorized(data: { paymentMethodData: unknown }): Promise<{ transactionState: "SUCCESS" | "ERROR"; error?: { message: string } }> } }) => GooglePaymentsClient } } };
  }
}

type Props = {
  /** Existing pending checkout order, such as a recovery/payment-status page. */
  orderId?: number;
  /** Called only after the buyer presses a provider-controlled payment action. */
  createOrder?: () => Promise<number>;
  /** Server-generated quote amount used only for provider eligibility messaging. */
  eligibilityAmount?: number;
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
export function PayPalCheckoutButton({ orderId, createOrder, eligibilityAmount, getToken, onCaptured, onAbandoned, disabled = false }: Props) {
  const walletContainer = useRef<HTMLDivElement>(null);
  const internalOrderId = useRef<number | undefined>(orderId);
  const sessions = useRef<Partial<Record<Method, WalletSession>>>({}); const attempt = useRef<{ id: number; providerOrderId: string } | undefined>(undefined);
  const busyRef = useRef(false);
  const applePaySession = useRef<ApplePaySessionApi | null>(null);
  const googlePay = useRef<{ session: GooglePaySessionApi; client: GooglePaymentsClient; config: ReturnType<GooglePaySessionApi["formatConfigForPaymentRequest"]> } | null>(null);
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
  const readWalletOrderInfo = useCallback(async (): Promise<WalletOrderInfo> => {
    const id = await resolveInternalOrder();
    const response = await fetch(`/api/orders/${id}`, { headers: await authHeaders(), credentials: "same-origin", cache: "no-store" });
    const order = await response.json() as { total?: number | string; remainingTenderAmount?: number | string; currency?: string };
    if (!response.ok || order.remainingTenderAmount == null || !Number.isFinite(Number(order.remainingTenderAmount)) || Number(order.remainingTenderAmount) <= 0) throw new Error("Server order amount is unavailable");
    return { amount: Number(order.remainingTenderAmount).toFixed(2), currency: order.currency ?? "USD", countryCode: "US" };
  }, [authHeaders, resolveInternalOrder]);
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
  const startApplePay = useCallback(async () => {
    const providerSession = applePaySession.current;
    const ApplePay = window.ApplePaySession;
    if (busyRef.current || disabled || !providerSession || !ApplePay || !ApplePay.canMakePayments()) return;
    busyRef.current = true; setBusy(true); setMessage(null);
    try {
      const walletOrder = await readWalletOrderInfo();
      const merchant = await providerSession.config();
      const session = new ApplePay(4, {
        countryCode: walletOrder.countryCode,
        currencyCode: walletOrder.currency,
        merchantCapabilities: merchant.merchantCapabilities,
        supportedNetworks: merchant.supportedNetworks,
        requiredBillingContactFields: ["name", "postalAddress"],
        requiredShippingContactFields: [],
        total: { label: "MyOrder.fun", amount: walletOrder.amount, type: "final" },
      });
      session.onvalidatemerchant = async event => {
        try { const { merchantSession } = await providerSession.validateMerchant({ validationUrl: event.validationURL }); session.completeMerchantValidation(merchantSession); }
        catch { setMessage("Apple Pay merchant validation failed. No payment was captured."); session.abort(); }
      };
      session.onpaymentauthorized = async event => {
        try {
          const attempt = await createProviderOrder();
          const result = await providerSession.confirmOrder({ orderId: attempt.providerOrderId, token: event.payment.token, billingContact: event.payment.billingContact, shippingContact: event.payment.shippingContact });
          if (result.status && result.status !== "APPROVED") throw new Error("Apple Pay order requires reconciliation");
          await capture(attempt.providerOrderId);
          session.completePayment({ status: ApplePay.STATUS_SUCCESS });
        } catch {
          session.completePayment({ status: ApplePay.STATUS_FAILURE });
          setMessage("Apple Pay could not be confirmed. Check order status before retrying.");
        }
      };
      session.oncancel = () => { void cancelAfterBuyerCancellation(); };
      session.begin();
    } catch { setMessage("Apple Pay could not start. No payment was confirmed."); }
    finally { busyRef.current = false; setBusy(false); }
  }, [cancelAfterBuyerCancellation, capture, createProviderOrder, disabled, readWalletOrderInfo]);
  const startGooglePay = useCallback(async () => {
    const wallet = googlePay.current;
    if (busyRef.current || disabled || !wallet) return;
    busyRef.current = true; setBusy(true); setMessage(null);
    try {
      const info = await readWalletOrderInfo();
      await wallet.client.loadPaymentData({
        ...wallet.config,
        transactionInfo: { countryCode: wallet.config.countryCode, currencyCode: info.currency, totalPriceStatus: "FINAL", totalPrice: info.amount },
        callbackIntents: ["PAYMENT_AUTHORIZATION"],
      });
    } catch { setMessage("Google Pay could not start. No payment was confirmed."); }
    finally { busyRef.current = false; setBusy(false); }
  }, [disabled, readWalletOrderInfo]);
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
      const sdk = await window.paypal.createInstance({ clientId: config.clientId, components: ["paypal-payments", "venmo-payments", "paypal-guest-payments", "applepay-payments", "googlepay-payments"], pageType: "checkout" });
      const methods = await sdk.findEligibleMethods({ currencyCode: config.currency ?? "USD", countryCode: config.countryCode ?? "US", ...(Number.isFinite(eligibilityAmount) ? { amount: Number(eligibilityAmount).toFixed(2) } : {}) });
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
      if (container && methods.isEligible("applepay") && sdk.createApplePayOneTimePaymentSession) {
        let appleScript = document.querySelector<HTMLScriptElement>('script[data-myorder-apple-pay="v1"]');
        if (!appleScript) { appleScript = document.createElement("script"); appleScript.dataset.myorderApplePay = "v1"; appleScript.src = "https://applepay.cdn-apple.com/jsapi/1.latest/apple-pay-sdk.js"; appleScript.async = true; document.head.appendChild(appleScript); }
        if (!window.ApplePaySession) await new Promise<void>((resolve, reject) => { appleScript!.addEventListener("load", () => resolve(), { once: true }); appleScript!.addEventListener("error", () => reject(new Error("Apple Pay SDK unavailable")), { once: true }); });
      }
      if (container && methods.isEligible("applepay") && window.ApplePaySession?.canMakePayments() && sdk.createApplePayOneTimePaymentSession) {
        const session = await sdk.createApplePayOneTimePaymentSession();
        applePaySession.current = session;
        const button = document.createElement("apple-pay-button");
        button.setAttribute("type", "pay"); button.setAttribute("buttonstyle", "black"); button.setAttribute("locale", "en"); button.setAttribute("aria-label", "Pay with Apple Pay");
        button.addEventListener("click", () => { void startApplePay(); });
        container.appendChild(button); eligibleCount++;
      }
      if (container && methods.isEligible("googlepay") && sdk.createGooglePayOneTimePaymentSession) {
        const details = methods.getDetails?.("googlepay");
        if (details?.config) {
          let googleScript = document.querySelector<HTMLScriptElement>('script[data-myorder-google-pay="v1"]');
          if (!googleScript) { googleScript = document.createElement("script"); googleScript.dataset.myorderGooglePay = "v1"; googleScript.src = "https://pay.google.com/gp/p/js/pay.js"; googleScript.async = true; document.head.appendChild(googleScript); }
          if (!window.google?.payments?.api?.PaymentsClient) await new Promise<void>((resolve, reject) => { googleScript!.addEventListener("load", () => resolve(), { once: true }); googleScript!.addEventListener("error", () => reject(new Error("Google Pay SDK unavailable")), { once: true }); });
          const GooglePaymentsClient = window.google?.payments?.api?.PaymentsClient;
          if (GooglePaymentsClient && !disposed) {
            const session = sdk.createGooglePayOneTimePaymentSession();
            const paymentConfig = session.formatConfigForPaymentRequest(details.config);
            const paymentsClient = new GooglePaymentsClient({
              environment: config.mode === "sandbox" ? "TEST" : "PRODUCTION",
              paymentDataCallbacks: {
                onPaymentAuthorized: async paymentData => {
                  try {
                    const attempt = await createProviderOrder();
                    const confirmed = await session.confirmOrder({ orderId: attempt.providerOrderId, paymentMethodData: paymentData.paymentMethodData });
                    if (confirmed.status !== "APPROVED") throw new Error("Google Pay requires additional provider action");
                    await capture(attempt.providerOrderId);
                    return { transactionState: "SUCCESS" };
                  } catch { setMessage("Google Pay could not be confirmed. Check order status before retrying."); return { transactionState: "ERROR", error: { message: "Payment could not be confirmed" } }; }
                },
              },
            });
            const ready = await paymentsClient.isReadyToPay({ allowedPaymentMethods: paymentConfig.allowedPaymentMethods, apiVersion: paymentConfig.apiVersion, apiVersionMinor: paymentConfig.apiVersionMinor });
            if (ready.result) {
              googlePay.current = { session, client: paymentsClient, config: paymentConfig };
              const button = paymentsClient.createButton({ onClick: () => { void startGooglePay(); } });
              button.setAttribute("aria-label", "Pay with Google Pay"); container.appendChild(button); eligibleCount++;
            }
          }
        }
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
  }, [authHeaders, cancelAfterBuyerCancellation, capture, createProviderOrder, eligibilityAmount, startApplePay, startGooglePay, startWallet]);

  return <div className="space-y-3" aria-busy={busy}>
    <div ref={walletContainer} data-testid="paypal-wallet-container" aria-label="PayPal Wallet" />
    {walletEligible === null && <p className="text-xs text-muted-foreground">Loading secure PayPal checkout…</p>}
    {walletEligible === false && <p className="text-xs text-muted-foreground">PayPal Wallet is unavailable for this account or session.</p>}
    {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
  </div>;
}
