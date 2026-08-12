export type PaymentMode = "disabled" | "sandbox" | "live";
export type PayPalEnvironment = "sandbox" | "live";

export type PaymentConfig =
  | { mode: "disabled"; provider: "paypal"; enabled: false }
  | { mode: "sandbox" | "live"; provider: "paypal"; enabled: true; environment: PayPalEnvironment; clientId: string; clientSecret: string; webhookId: string; apiOrigin: string };

export class PaymentConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "PaymentConfigurationError"; }
}

const ORIGINS: Record<PayPalEnvironment, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

export function loadPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig {
  const rawMode = env.PAYMENT_MODE?.trim().toLowerCase();
  const mode: PaymentMode = rawMode === undefined || rawMode === "" ? "disabled" : rawMode as PaymentMode;
  if (!["disabled", "sandbox", "live"].includes(mode)) throw new PaymentConfigurationError("Unsupported PAYMENT_MODE");

  const provider = env.PAYMENT_PROVIDER?.trim().toLowerCase() || "paypal";
  if (provider !== "paypal") throw new PaymentConfigurationError("PAYMENT_PROVIDER must be paypal");
  if (env.PAYPAL_API_BASE_URL) throw new PaymentConfigurationError("PAYPAL_API_BASE_URL is not configurable");

  const configured = [env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET, env.PAYPAL_WEBHOOK_ID, env.PAYPAL_ENVIRONMENT].some(v => Boolean(v?.trim()));
  if (mode === "disabled") {
    if (configured) throw new PaymentConfigurationError("PayPal credentials/environment must be absent when payments are disabled");
    return { mode, provider: "paypal", enabled: false };
  }

  const environment = env.PAYPAL_ENVIRONMENT?.trim().toLowerCase() as PayPalEnvironment | undefined;
  if (environment !== "sandbox" && environment !== "live") throw new PaymentConfigurationError("PAYPAL_ENVIRONMENT must be sandbox or live");
  if (environment !== mode) throw new PaymentConfigurationError("PAYMENT_MODE and PAYPAL_ENVIRONMENT must match");
  if (env.NODE_ENV === "staging" && mode === "live") throw new PaymentConfigurationError("Staging cannot use live payments");
  if (mode === "live" && env.NODE_ENV !== "production") throw new PaymentConfigurationError("Live payments require NODE_ENV=production");

  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  const webhookId = env.PAYPAL_WEBHOOK_ID?.trim();
  if (!clientId || !clientSecret || !webhookId) throw new PaymentConfigurationError("Complete PayPal credentials are required");
  return { mode, provider: "paypal", enabled: true, environment, clientId, clientSecret, webhookId, apiOrigin: ORIGINS[environment] };
}

export function requireOnlinePayments(config = loadPaymentConfig()): Extract<PaymentConfig, { enabled: true }> {
  if (!config.enabled) throw Object.assign(new Error("Online payments are disabled"), { statusCode: 503, code: "PAYMENTS_DISABLED" });
  return config;
}
