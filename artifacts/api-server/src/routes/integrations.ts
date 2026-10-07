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
import { eq } from "drizzle-orm";
import { adminSettingsTable, db } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { getUberDirectRuntimeConfig } from "../lib/uberDirectConfig";
import { safeDecrypt } from "../lib/crypto";
import { fetchWooSafely } from "../lib/wooSafeHttp";
import { loadTenantPaymentConfig } from "../payments/tenantConfig";

const router: IRouter = Router();

type IntegrationStatus = "connected" | "missing_config" | "error";

interface IntegrationResult {
  paypal: IntegrationStatus;
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

async function checkPayPal(tenantId: number): Promise<IntegrationStatus> {
  try { return (await loadTenantPaymentConfig(tenantId)).enabled ? "connected" : "missing_config"; }
  catch { return "error"; }
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

/** Use the same tenant credentials and safe transport as the admin test. */
async function checkWooCommerce(tenantId: number): Promise<IntegrationStatus> {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) return "missing_config";
  try {
    const [row] = await db.select({ enabled: adminSettingsTable.wcEnabled, storeUrl: adminSettingsTable.wcStoreUrl,
      consumerKey: adminSettingsTable.wcConsumerKey, consumerSecret: adminSettingsTable.wcConsumerSecret })
      .from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, tenantId)).limit(1);
    if (!row || row.enabled === false || !row.storeUrl?.trim() || !row.consumerKey || !row.consumerSecret) return "missing_config";
    const consumerKey = safeDecrypt(row.consumerKey);
    const consumerSecret = safeDecrypt(row.consumerSecret);
    if (!consumerKey || !consumerSecret) return "error";
    const response = await fetchWooSafely(row.storeUrl, "/wp-json/wc/v3/system_status", consumerKey, consumerSecret);
    return response.ok ? "connected" : "error";
  } catch { return "error"; }
}

/**
 * RevenueCat: optional SaaS licensing / entitlement gating.
 * This integration is unrelated to the PayPal order-payment authority.
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

async function checkUberDirect(tenantId: number): Promise<IntegrationStatus> {
  try { return await getUberDirectRuntimeConfig(tenantId) ? "connected" : "missing_config"; }
  catch { return "error"; }
}

// ─── Route ───────────────────────────────────────────────────────────────────

router.get(
  "/integrations/health",
  requireAuth,
  loadDbUser,
  requireDbUser,
  requireApproved,
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    // Run all checks concurrently; individual check failures are caught
    // internally and return "error" rather than throwing.
    const result: IntegrationResult = {
      paypal: await checkPayPal(req.dbUser!.tenantId!),
      airtable: checkAirtable(),
      github: checkGitHub(),
      woocommerce: await checkWooCommerce(req.dbUser!.tenantId!),
      revenuecat: checkRevenueCat(),
      openai: checkOpenAI(),
      uberDirect: await checkUberDirect(req.dbUser!.tenantId!),
    };

    res.json(result);
  },
);

export default router;
