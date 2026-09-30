// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayPalCheckoutButton } from "../PayPalCheckoutButton";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  document.querySelector('script[data-myorder-paypal-sdk="v6"]')?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
  delete window.paypal;
});

describe("PayPal Wallet DOM ownership", () => {
  it("allows the SDK button to replace its container while React removes the loading message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      enabled: true, mode: "sandbox", clientId: "test-public-client-id", currency: "USD",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    window.paypal = {
      createInstance: vi.fn(async () => ({
        findEligibleMethods: async () => ({ isEligible: () => true }),
        createPayPalOneTimePaymentSession: () => ({ start: async () => {} }),
      })),
    };
    const script = document.createElement("script");
    script.dataset.myorderPaypalSdk = "v6";
    document.head.append(script);

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<PayPalCheckoutButton getToken={async () => null} onCaptured={() => {}} />);
    });

    expect(host.querySelector("paypal-button")).not.toBeNull();
    expect(host.textContent).not.toContain("Loading secure PayPal checkout");
  });
});
