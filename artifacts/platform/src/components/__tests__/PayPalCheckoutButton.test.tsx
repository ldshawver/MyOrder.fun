// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PayPalCheckoutButton } from "../PayPalCheckoutButton";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.querySelector('script[data-myorder-paypal-sdk="v6"]')?.remove();
  delete window.paypal;
  delete window.ApplePaySession;
  delete window.google;
  document.querySelector('script[data-myorder-google-pay="v1"]')?.remove();
  vi.unstubAllGlobals();
});

async function renderButton() {
  await act(async () => {
    root.render(<PayPalCheckoutButton getToken={async () => "test-token"} onCaptured={() => undefined} />);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe("PayPal Wallet checkout", () => {
  it("shows a configuration message and no payment action when disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ enabled: false, mode: "disabled" }) });
    vi.stubGlobal("fetch", fetchMock);
    await renderButton();
    expect(host.textContent).toContain("live payment configuration is incomplete");
    expect(host.querySelector("paypal-button")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/payments/config", expect.objectContaining({ cache: "no-store" }));
  });

  it("renders the official v6 Wallet element only when the SDK reports eligibility", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ enabled: true, mode: "live", clientId: "public-test-client", currency: "USD" }) }));
    const findEligibleMethods = vi.fn().mockResolvedValue({ isEligible: () => true });
    const createPayPalOneTimePaymentSession = vi.fn().mockReturnValue({ start: vi.fn() });
    window.paypal = { createInstance: vi.fn().mockResolvedValue({ findEligibleMethods, createPayPalOneTimePaymentSession }) };
    await renderButton();
    expect(window.paypal.createInstance).toHaveBeenCalledWith({ clientId: "public-test-client", components: ["paypal-payments", "venmo-payments", "paypal-guest-payments", "applepay-payments", "googlepay-payments"], pageType: "checkout" });
    expect(findEligibleMethods).toHaveBeenCalledWith({ currencyCode: "USD", countryCode: "US" });
    expect(host.querySelector("paypal-button[type=pay]")).not.toBeNull();
    expect(createPayPalOneTimePaymentSession).toHaveBeenCalledTimes(1);
  });

  it("shows an unavailable state when the SDK says Wallet is ineligible", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ enabled: true, mode: "live", clientId: "public-test-client" }) }));
    window.paypal = { createInstance: vi.fn().mockResolvedValue({ findEligibleMethods: async () => ({ isEligible: () => false }), createPayPalOneTimePaymentSession: vi.fn() }) };
    await renderButton();
    expect(host.querySelector("paypal-button")).toBeNull();
    expect(host.textContent).toContain("PayPal Wallet is unavailable");
  });

  it("passes the server-created PayPal order to v6 and captures only after onApprove", async () => {
    const onCaptured = vi.fn();
    const start = vi.fn(async (_options, order: Promise<{ orderId: string }>) => {
      expect(await order).toEqual({ orderId: "PROVIDER-43" });
    });
    let onApprove: ((data: { orderId: string }) => Promise<void>) | undefined;
    window.paypal = { createInstance: vi.fn(async () => ({
      findEligibleMethods: async () => ({ isEligible: (method: string) => method === "paypal" }),
      createPayPalOneTimePaymentSession: (options: { onApprove(data: { orderId: string }): Promise<void> }) => { onApprove = options.onApprove; return { start }; },
    })) };
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url === "/api/payments/config" ? { enabled: true, mode: "sandbox", clientId: "public-client", currency: "USD" }
        : url.endsWith("/capture") ? { status: "captured" } : { attemptId: 11, providerOrderId: "PROVIDER-43" },
    ), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const script = document.createElement("script"); script.dataset.myorderPaypalSdk = "v6"; document.head.append(script);
    await act(async () => { root.render(<PayPalCheckoutButton orderId={43} getToken={async () => "test-token"} onCaptured={onCaptured} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { host.querySelector("paypal-button")?.dispatchEvent(new MouseEvent("click")); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(start).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/capture"))).toBe(false);
    await act(async () => { await onApprove?.({ orderId: "PROVIDER-43" }); });
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/capture"))).toBe(true);
    expect(onCaptured).toHaveBeenCalledWith(43);
  });

  it("uses the authoritative order amount for the eligible Apple Pay sheet and captures through MyOrder", async () => {
    let authorize: ((event: { payment: { token: unknown; billingContact: unknown } }) => Promise<void>) | null = null;
    const appleRequest: { current?: Record<string, unknown> } = {};
    let began = false;
    class NativeApplePaySession {
      static latest: NativeApplePaySession | undefined;
      static STATUS_SUCCESS = 1;
      static STATUS_FAILURE = 0;
      static canMakePayments = () => true;
      onvalidatemerchant: ((event: { validationURL: string }) => void) | null = null;
      onpaymentauthorized: typeof authorize = null;
      oncancel: (() => void) | null = null;
      constructor(_version: number, request: Record<string, unknown>) { appleRequest.current = request; NativeApplePaySession.latest = this; }
      begin() { began = true; }
      abort() {}
      completeMerchantValidation() {}
      completePayment() {}
    }
    Object.assign(window, { ApplePaySession: NativeApplePaySession });
    const appleSession = {
      config: async () => ({ merchantCapabilities: ["supports3DS"], supportedNetworks: ["visa"] }),
      validateMerchant: async () => ({ merchantSession: {} }),
      confirmOrder: vi.fn(async () => ({ status: "APPROVED" })),
    };
    window.paypal = { createInstance: vi.fn(async () => ({
      findEligibleMethods: async () => ({ isEligible: (method: string) => method === "applepay" }),
      createPayPalOneTimePaymentSession: () => ({ start: async () => {}, hasReturned: () => false }),
      createApplePayOneTimePaymentSession: async () => appleSession,
    })) };
    const onCaptured = vi.fn();
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url === "/api/payments/config" ? { enabled: true, mode: "sandbox", clientId: "public-client", currency: "USD", countryCode: "US" }
        : url === "/api/orders/43" ? { remainingTenderAmount: 1.09, total: 1.09 }
          : url.endsWith("/capture") ? { status: "captured" } : { attemptId: 11, providerOrderId: "PROVIDER-APPLE-43" },
    ), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const sdkScript = document.createElement("script"); sdkScript.dataset.myorderPaypalSdk = "v6"; document.head.append(sdkScript);
    await act(async () => { root.render(<PayPalCheckoutButton orderId={43} getToken={async () => "test-token"} onCaptured={onCaptured} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { host.querySelector('apple-pay-button[aria-label="Pay with Apple Pay"]')?.dispatchEvent(new MouseEvent("click")); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(began).toBe(true);
    expect((appleRequest.current?.total as { amount?: string }).amount).toBe("1.09");
    authorize = NativeApplePaySession.latest?.onpaymentauthorized ?? null;
    expect(authorize).toBeTypeOf("function");
    await act(async () => {
      await authorize?.({ payment: { token: { paymentData: "test-token" }, billingContact: {} } });
    });
    expect(appleSession.confirmOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: "PROVIDER-APPLE-43" }));
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/capture"))).toBe(true);
    expect(onCaptured).toHaveBeenCalledWith(43);
  });

  it("confirms eligible Google Pay through PayPal v6 before calling the MyOrder capture endpoint", async () => {
    let authorize: ((data: { paymentMethodData: unknown }) => Promise<{ transactionState: string }>) | undefined;
    const loadPaymentData = vi.fn(async () => { await authorize?.({ paymentMethodData: { token: "google-test-token" } }); });
    class PaymentsClient {
      constructor(options: { paymentDataCallbacks: { onPaymentAuthorized(data: { paymentMethodData: unknown }): Promise<{ transactionState: string }> } }) { authorize = options.paymentDataCallbacks.onPaymentAuthorized; }
      isReadyToPay = async () => ({ result: true });
      createButton = (options: { onClick(): void }) => { const button = document.createElement("button"); button.addEventListener("click", options.onClick); return button; };
      loadPaymentData = loadPaymentData;
    }
    Object.assign(window, { google: { payments: { api: { PaymentsClient } } } });
    const googleSession = {
      formatConfigForPaymentRequest: vi.fn(() => ({ allowedPaymentMethods: [], apiVersion: 2, apiVersionMinor: 0, countryCode: "US" })),
      confirmOrder: vi.fn(async () => ({ status: "APPROVED" })),
    };
    window.paypal = { createInstance: vi.fn(async () => ({
      findEligibleMethods: async () => ({ isEligible: (method: string) => method === "googlepay", getDetails: () => ({ config: { provider: "paypal" } }) }),
      createPayPalOneTimePaymentSession: () => ({ start: async () => {}, hasReturned: () => false }),
      createGooglePayOneTimePaymentSession: () => googleSession,
    })) };
    const onCaptured = vi.fn();
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url === "/api/payments/config" ? { enabled: true, mode: "sandbox", clientId: "public-client", currency: "USD", countryCode: "US" }
        : url === "/api/orders/43" ? { remainingTenderAmount: 1.09, total: 1.09 }
          : url.endsWith("/capture") ? { status: "captured" } : { attemptId: 11, providerOrderId: "PROVIDER-GOOGLE-43" },
    ), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const sdkScript = document.createElement("script"); sdkScript.dataset.myorderPaypalSdk = "v6"; document.head.append(sdkScript);
    const googleScript = document.createElement("script"); googleScript.dataset.myorderGooglePay = "v1"; document.head.append(googleScript);
    await act(async () => { root.render(<PayPalCheckoutButton orderId={43} getToken={async () => "test-token"} onCaptured={onCaptured} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => { host.querySelector('button[aria-label="Pay with Google Pay"]')?.dispatchEvent(new MouseEvent("click")); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(googleSession.confirmOrder).toHaveBeenCalledWith({ orderId: "PROVIDER-GOOGLE-43", paymentMethodData: { token: "google-test-token" } });
    expect(loadPaymentData).toHaveBeenCalledWith(expect.objectContaining({ transactionInfo: expect.objectContaining({ totalPrice: "1.09", currencyCode: "USD" }) }));
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/capture"))).toBe(true);
    expect(onCaptured).toHaveBeenCalledWith(43);
  });
});
