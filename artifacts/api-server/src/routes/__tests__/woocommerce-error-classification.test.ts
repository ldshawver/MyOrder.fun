import { describe, expect, it } from "vitest";
import { WooCommerceUpstreamError, wooFailureResponse } from "../woocommerce";

describe("WooCommerce upstream error classification", () => {
  it.each([
    ["authentication", 401, 424, "woocommerce_auth_failed"],
    ["configuration", 404, 422, "woocommerce_endpoint_not_found"],
    ["unavailable", 503, 503, "woocommerce_unavailable"],
    ["timeout", null, 504, "woocommerce_timeout"],
    ["malformed", 200, 502, "woocommerce_malformed_response"],
  ] as const)("returns a safe %s response", (kind, upstreamStatus, status, code) => {
    const result = wooFailureResponse(new WooCommerceUpstreamError(kind, upstreamStatus));
    expect(result.status).toBe(status);
    expect(result.body).toMatchObject({ ok: false, code, upstreamStatus });
    expect(result.body.message).not.toContain("consumer");
    expect(result.body.message).not.toContain("secret");
  });

  it("does not return arbitrary upstream error text", () => {
    const result = wooFailureResponse(new Error("upstream token=do-not-return-this"));
    expect(result.body.message).toBe("WooCommerce is temporarily unavailable.");
    expect(JSON.stringify(result.body)).not.toContain("do-not-return-this");
  });
});
