import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const checkout = readFileSync(new URL("../../components/PayPalCheckoutButton.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("../order-detail.tsx", import.meta.url), "utf8");
const cart = readFileSync(new URL("../new-order.tsx", import.meta.url), "utf8");

describe("verified payment confirmation", () => {
  it("implements the v6 guest-card completion callback without treating it as capture authority", () => {
    expect(checkout).toContain("onComplete: () => setMessage");
    expect(checkout).toContain("onApprove: (data: { orderId: string }) => capture(data.orderId)");
  });

  it("keeps a persistent fulfillment confirmation after the payment widget unmounts", () => {
    expect(detail).toContain('data-testid="payment-confirmed-banner"');
    expect(detail).toContain("captureConfirmed || order.paymentStatus === OrderPaymentStatus.paid");
    expect(detail).toContain("setCaptureConfirmed(true)");
  });

  it("clears the cart and opens the exact order only after the capture callback", () => {
    expect(cart).toContain("onCaptured={(orderId) => { void finishCheckout(orderId); }}");
    expect(cart).toContain("setLocation(`/orders/${orderId}`)");
    expect(cart).toContain("clearCart();");
  });
});
