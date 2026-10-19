/** Explicit process-wide gate for every external WooCommerce operation. */
export const WOO_EXTERNAL_INTEGRATION_ENV = "WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED";

export function isWooCommerceExternalIntegrationEnabled(): boolean {
  return process.env[WOO_EXTERNAL_INTEGRATION_ENV] === "true" ||
    (process.env.NODE_ENV === "test" && process.env[WOO_EXTERNAL_INTEGRATION_ENV] === undefined);
}

/** Production and staging must never infer a policy from missing credentials. */
export function assertWooCommerceExternalIntegrationPolicy(): void {
  const policy = process.env[WOO_EXTERNAL_INTEGRATION_ENV];
  if (policy !== "true" && policy !== "false") {
    throw new Error(`${WOO_EXTERNAL_INTEGRATION_ENV} must be explicitly set to true or false`);
  }
}

export function wooCommerceDisabledResponse(): { error: string; code: string } {
  return { error: "External WooCommerce integration is disabled", code: "woocommerce_external_integration_disabled" };
}
