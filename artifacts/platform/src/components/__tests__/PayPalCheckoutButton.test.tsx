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
    expect(window.paypal.createInstance).toHaveBeenCalledWith({ clientId: "public-test-client", components: ["paypal-payments", "venmo-payments", "paypal-guest-payments"], pageType: "checkout" });
    expect(findEligibleMethods).toHaveBeenCalledWith({ currencyCode: "USD" });
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
});
