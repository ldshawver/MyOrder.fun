/**
 * GET /api/integrations/health
 *
 * Admin-only endpoint that reports the configuration status of every
 * external integration used by MyOrder.fun.
 *
 * SAFETY RULES:
 * - Reports one of three states: "connected" | "missing_config" | "error"
 * - "connected"     = required env vars present; a lightweight live check
 *                     succeeded (where feasible without risk/latency).
 * - "missing_config" = one or more required env vars are absent/empty.
 * - "error"          = env vars present but a quick sanity check failed.
 * - No secret values, URLs, or credentials are ever included in the response.
 * - Response body is strictly the status object — no debug info that could
 *   aid an attacker.
 *
 * Live connectivity checks are intentionally lightweight (a single cheap API
 * call with a 3-second timeout). Integrations without a safe cheap check
 * (e.g. Airtable, RevenueCat) report "connected" on config presence alone.
 */
import { Router, type IRouter } from "express";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { logger } from "../lib/logger";
import { hasUberDirectConfig } from "../lib/uberDirect";

const router: IRouter = Router();

type IntegrationStatus = "connected" | "missing_config" | "error";

interface IntegrationResult {
  stripe: IntegrationStatus;
  airtable: IntegrationStatus;
  github: IntegrationStatus;
  woocommerce: IntegrationStatus;
  revenuecat: IntegrationStatus;
  openai: IntegrationStatus;
  uberDirect: IntegrationStatus;
}

function hasEnv(...keys: string[]): boolean {
  return keys.every((k) => {
    const v = process.env[k];
    return typeof v === "string" && v.trim().length > 0;
  });
}

/**
 * Attempt a lightweight live check against Stripe's API.
 * Uses the /v1/balance endpoint — minimal permissions, cheap, stable.
 * Falls back to "connected" (config-only) if the fetch itself errors out
 * for an unexpected reason (network unavailable, etc.) to avoid false
 * negatives in environments where outbound traffic is restricted.
 */
async function checkStripe(): Promise<IntegrationStatus> {
  if (!hasEnv("STRIPE_SECRET_KEY")) return "missing_config";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("https://api.stripe.com/v1/balance", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env["STRIPE_SECRET_KEY"]}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // 200 = connected; 401 = key invalid (error); anything else treat as error.
    return res.ok ? "connected" : "error";
  } catch (err) {
    logger.warn({ err }, "integrations/health: Stripe live check failed");
    // Network issue ≠ misconfiguration; treat as "error" so operators can see it.
    return "error";
  }
}

/**
 * Airtable: check API key + base ID presence.
 */
function checkAirtable(): IntegrationStatus {
  return hasEnv("AIRTABLE_API_KEY", "AIRTABLE_BASE_ID") ? "connected" : "missing_config";
}

/**
 * GitHub: token + repository.
 * Used for AI-generated bug report tickets and deployment visibility.
 */
function checkGitHub(): IntegrationStatus {
  return hasEnv("GITHUB_TOKEN", "GITHUB_REPO") ? "connected" : "missing_config";
}

/**
 * WooCommerce: server-side URL + consumer key/secret.
 * Note: VITE_WOOCOMMERCE_URL is a frontend-only build var and is NOT
 * checked here — use WOOCOMMERCE_URL (no VITE_ prefix) for server-side
 * integration work. The frontend var controls only the menu tab link.
 */
function checkWooCommerce(): IntegrationStatus {
  return hasEnv("WOOCOMMERCE_URL", "WOOCOMMERCE_KEY", "WOOCOMMERCE_SECRET")
    ? "connected"
    : "missing_config";
}

/**
 * RevenueCat: optional SaaS licensing / entitlement gating.
 * Not used for order payments (Stripe is the payment authority).
 */
function checkRevenueCat(): IntegrationStatus {
  return hasEnv("REVENUECAT_SECRET_KEY") ? "connected" : "missing_config";
}

/**
 * OpenAI: AI concierge. Included because it affects UX in a visible way
 * (concierge degrades to stub without it) and operators should know.
 */
function checkOpenAI(): IntegrationStatus {
  return hasEnv("OPENAI_API_KEY") ? "connected" : "missing_config";
}

function checkUberDirect(): IntegrationStatus {
  return hasUberDirectConfig() ? "connected" : "missing_config";
}

// ─── Route ───────────────────────────────────────────────────────────────────

router.get(
  "/integrations/health",
  requireAuth,
  loadDbUser,
  requireDbUser,
  requireApproved,
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    // Run all checks concurrently; individual check failures are caught
    // internally and return "error" rather than throwing.
    const [stripe] = await Promise.all([checkStripe()]);

    const result: IntegrationResult = {
      stripe,
      airtable: checkAirtable(),
      github: checkGitHub(),
      woocommerce: checkWooCommerce(),
      revenuecat: checkRevenueCat(),
      openai: checkOpenAI(),
      uberDirect: checkUberDirect(),
    };

    res.json(result);
  },
);

export default router;
