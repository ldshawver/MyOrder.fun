import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, adminSettingsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { encrypt, safeDecrypt } from "../lib/crypto";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const ROUTING_RULES = ["round_robin", "least_recent_order", "supervisor_manual_assignment"] as const;
type RoutingRule = typeof ROUTING_RULES[number];

function mapSettings(s: typeof adminSettingsTable.$inferSelect) {
  return {
    id: s.id,
    orderRoutingRule: (s.orderRoutingRule ?? "round_robin") as RoutingRule,
    defaultEtaMinutes: s.defaultEtaMinutes ?? 30,
    menuImportEnabled: s.menuImportEnabled,
    showOutOfStock: s.showOutOfStock,
    enabledProcessors: s.enabledProcessors,
    checkoutConversionPreview: s.checkoutConversionPreview,
    merchantImageEnabled: s.merchantImageEnabled,
    autoPrintOnPayment: s.autoPrintOnPayment,
    receiptTemplateStyle: s.receiptTemplateStyle,
    labelTemplateStyle: s.labelTemplateStyle,
    purgeMode: s.purgeMode,
    purgeDelayHours: s.purgeDelayHours,
    keepAuditToken: s.keepAuditToken,
    keepFailedPaymentLogs: s.keepFailedPaymentLogs,
    receiptLineNameMode: s.receiptLineNameMode ?? "lucifer_only",
    // WooCommerce — secrets are returned as a boolean mask only,
    // never echoed back to the client in plaintext.
    wcStoreUrl: s.wcStoreUrl ?? "https://lucifercruz.com",
    wcConsumerKeySet: !!s.wcConsumerKey,
    wcConsumerSecretSet: !!s.wcConsumerSecret,
    wcEnabled: s.wcEnabled ?? true,
    updatedAt: s.updatedAt,
  };
}

// Single-tenant: use the one global settings row, creating it if absent
async function getOrCreateSettings() {
  const [existing] = await db.select().from(adminSettingsTable).limit(1);
  if (existing) return existing;
  const tenantId = await getHouseTenantId();
  const [created] = await db.insert(adminSettingsTable).values({ tenantId }).returning();
  return created;
}

/**
 * Decrypt the WooCommerce credentials stored on a settings row.
 * Returns null for either field if decryption fails or the column is empty.
 * Used by the woocommerce route to load creds for syncs / connection tests.
 */
async function getDecryptedWooCreds(): Promise<{
  storeUrl: string;
  consumerKey: string | null;
  consumerSecret: string | null;
  enabled: boolean;
}> {
  const s = await getOrCreateSettings();
  return {
    storeUrl: s.wcStoreUrl ?? "https://lucifercruz.com",
    consumerKey: safeDecrypt(s.wcConsumerKey),
    consumerSecret: safeDecrypt(s.wcConsumerSecret),
    enabled: s.wcEnabled ?? true,
  };
}

// GET /api/admin/settings
router.get("/admin/settings", requireRole("admin", "supervisor"), async (_req, res): Promise<void> => {
  const s = await getOrCreateSettings();
  res.json(mapSettings(s));
});

// PUT /api/admin/settings
router.put("/admin/settings", requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const allowed = [
    "menuImportEnabled", "showOutOfStock", "enabledProcessors",
    "checkoutConversionPreview", "merchantImageEnabled", "autoPrintOnPayment",
    "receiptTemplateStyle", "labelTemplateStyle", "purgeMode",
    "purgeDelayHours", "keepAuditToken", "keepFailedPaymentLogs",
    "receiptLineNameMode",
  ];
  const body = (req.body ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  for (const k of allowed) {
    if (body[k] !== undefined) update[k] = body[k];
  }
  if (body.orderRoutingRule !== undefined) {
    if (typeof body.orderRoutingRule !== "string" || !(ROUTING_RULES as readonly string[]).includes(body.orderRoutingRule)) {
      res.status(400).json({ error: `orderRoutingRule must be one of ${ROUTING_RULES.join(", ")}` });
      return;
    }
    update.orderRoutingRule = body.orderRoutingRule;
  }
  if (body.defaultEtaMinutes !== undefined) {
    const n = Number(body.defaultEtaMinutes);
    if (!Number.isInteger(n) || n < 1) {
      res.status(400).json({ error: "defaultEtaMinutes must be a positive integer" });
      return;
    }
    update.defaultEtaMinutes = n;
  }

  const existing = await getOrCreateSettings();
  if (Object.keys(update).length === 0) {
    res.json(mapSettings(existing));
    return;
  }
  const [updated] = await db.update(adminSettingsTable)
    .set(update)
    .where(eq(adminSettingsTable.id, existing.id))
    .returning();
  res.json(mapSettings(updated));
});

/**
 * GET /api/admin/settings/woocommerce
 * Returns the WC config in masked form. Secrets are NEVER returned in plaintext —
 * only boolean flags indicating whether they have been saved.
 */
router.get("/admin/settings/woocommerce", requireRole("admin", "supervisor"), async (_req, res): Promise<void> => {
  const s = await getOrCreateSettings();
  res.json({
    wc_store_url: s.wcStoreUrl ?? "https://lucifercruz.com",
    wcStoreUrl: s.wcStoreUrl ?? "https://lucifercruz.com",
    enabled: s.wcEnabled ?? true,
    hasConsumerKey: !!s.wcConsumerKey,
    hasConsumerSecret: !!s.wcConsumerSecret,
    wcConsumerKeySet: !!s.wcConsumerKey,
    wcConsumerSecretSet: !!s.wcConsumerSecret,
    wcEnabled: s.wcEnabled ?? true,
  });
});

/**
 * PUT /api/admin/settings/woocommerce — save WooCommerce credentials.
 * Secrets are encrypted at rest using AES-256-GCM keyed off SETTINGS_ENC_KEY.
 * They are never echoed back to the client.
 */
router.put("/admin/settings/woocommerce", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const body = (req.body ?? {}) as {
      wcStoreUrl?: string; wc_store_url?: string;
      wcConsumerKey?: string; wc_consumer_key?: string;
      wcConsumerSecret?: string; wc_consumer_secret?: string;
      enabled?: boolean; wcEnabled?: boolean;
    };

    const storeUrl = body.wcStoreUrl ?? body.wc_store_url;
    const consumerKey = body.wcConsumerKey ?? body.wc_consumer_key;
    const consumerSecret = body.wcConsumerSecret ?? body.wc_consumer_secret;
    const enabled = body.enabled ?? body.wcEnabled;

    const update: Record<string, unknown> = {};
    if (storeUrl !== undefined) {
      const trimmed = String(storeUrl).trim();
      update["wcStoreUrl"] = trimmed || "https://lucifercruz.com";
    }
    if (consumerKey !== undefined) {
      const trimmed = String(consumerKey).trim();
      update["wcConsumerKey"] = trimmed ? encrypt(trimmed) : null;
    }
    if (consumerSecret !== undefined) {
      const trimmed = String(consumerSecret).trim();
      update["wcConsumerSecret"] = trimmed ? encrypt(trimmed) : null;
    }
    if (enabled !== undefined) {
      update["wcEnabled"] = !!enabled;
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "No fields provided" });
      return;
    }

    const existing = await getOrCreateSettings();
    const [updated] = await db.update(adminSettingsTable)
      .set(update)
      .where(eq(adminSettingsTable.id, existing.id))
      .returning();
    res.json(mapSettings(updated));
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message ?? "Failed to save WooCommerce settings" });
  }
});

export { getOrCreateSettings, getDecryptedWooCreds };
export default router;
