import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, adminSettingsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { encrypt, safeDecrypt } from "../lib/crypto";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const ROUTING_RULES = ["round_robin", "least_recent_order", "supervisor_manual_assignment"] as const;
type RoutingRule = typeof ROUTING_RULES[number];

// Hard cap on the admin-editable AI prompt to avoid pathological prompts
// or accidental paste-the-whole-document mistakes blowing the model context.
export const AI_CONCIERGE_PROMPT_MAX_CHARS = 8000;
let importTemplateColumnEnsured = false;

function mapSettings(s: typeof adminSettingsTable.$inferSelect) {
  const aiPrompt = s.aiConciergePrompt ?? null;
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
    aiConciergePrompt: aiPrompt,
    aiConciergePromptIsDefault: aiPrompt === null || aiPrompt.trim() === "",
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
  if (!importTemplateColumnEnsured) {
    await db.execute(sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "import_template_spec" text`);
    importTemplateColumnEnsured = true;
  }
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
  if (body.aiConciergePrompt !== undefined) {
    if (body.aiConciergePrompt === null) {
      update.aiConciergePrompt = null;
    } else if (typeof body.aiConciergePrompt !== "string") {
      res.status(400).json({ error: "aiConciergePrompt must be a string or null" });
      return;
    } else {
      const trimmed = body.aiConciergePrompt.trim();
      if (trimmed.length === 0) {
        // Empty string === revert to default.
        update.aiConciergePrompt = null;
      } else if (body.aiConciergePrompt.length > AI_CONCIERGE_PROMPT_MAX_CHARS) {
        res.status(400).json({
          error: `aiConciergePrompt exceeds maximum length of ${AI_CONCIERGE_PROMPT_MAX_CHARS} characters`,
        });
        return;
      } else {
        update.aiConciergePrompt = body.aiConciergePrompt;
      }
    }
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

// ─── Concierge Promoted Items ─────────────────────────────────────────────────

function parseIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

// GET /api/concierge/promoted — authenticated users: returns full catalog items
router.get("/concierge/promoted", async (_req, res): Promise<void> => {
  const s = await getOrCreateSettings();
  const ids = parseIds(s.conciergePromotedItemIds);
  if (ids.length === 0) { res.json([]); return; }
  const { catalogItemsTable } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  const rows = await db.select().from(catalogItemsTable).where(inArray(catalogItemsTable.id, ids));
  const ordered = ids.map(id => rows.find(r => r.id === id)).filter(Boolean);
  res.json(ordered.map(i => ({
    id: i!.id,
    name: i!.alavontName ?? i!.name,
    category: i!.alavontCategory ?? i!.category,
    price: parseFloat(i!.price as string),
    imageUrl: i!.alavontImageUrl ?? i!.imageUrl ?? null,
    isAvailable: i!.isAvailable,
  })));
});

// GET /api/admin/concierge/promoted — admin/supervisor: returns IDs
router.get("/admin/concierge/promoted", requireRole("admin", "supervisor"), async (_req, res): Promise<void> => {
  const s = await getOrCreateSettings();
  res.json({ ids: parseIds(s.conciergePromotedItemIds) });
});

// PUT /api/admin/concierge/promoted — admin: sets promoted item IDs
router.put("/admin/concierge/promoted", requireRole("admin"), async (req, res): Promise<void> => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length > 8 || !ids.every(x => Number.isInteger(x) && x > 0)) {
    res.status(400).json({ error: "ids must be an array of up to 8 positive integers" });
    return;
  }
  const existing = await getOrCreateSettings();
  await db.update(adminSettingsTable)
    .set({ conciergePromotedItemIds: JSON.stringify(ids) })
    .where(eq(adminSettingsTable.id, existing.id));
  res.json({ ids });
});

// ─── Concierge Intro Steps ────────────────────────────────────────────────────

const DEFAULT_CONCIERGE_STEPS = [
  { emoji: "⚡", title: "Hey! I'm Zappy", body: "Your personal shopping buddy for everything at Alavont & Lucifer Cruz. No judgment, no awkwardness — just me helping you find what you need. I know this menu inside and out.", cta: "Let's go!" },
  { emoji: "🛍️", title: "Explore the Menu", body: "Browse hundreds of products by category or just tell me what you're into. Search it, ask me, or I'll recommend something that fits. We'll find it together.", cta: "Got it, nice!" },
  { emoji: "🛒", title: "Order Like a Pro", body: "Take a quick look at your cart before checking out. Double-check the details — quantities, product names, the works. Once it's in, it's in. No stress though, I got you.", cta: "Sounds good!" },
  { emoji: "📱", title: "Track It & Chill", body: "After checkout, updates come straight here — no calls needed. Sit back, relax. When your order's ready, you'll know. I'll be here if you need anything else.", cta: "I'm ready ⚡" },
];

function parseSteps(raw: string | null | undefined) {
  if (!raw) return DEFAULT_CONCIERGE_STEPS;
  try { return JSON.parse(raw); } catch { return DEFAULT_CONCIERGE_STEPS; }
}

// GET /api/concierge/intro-steps — any authenticated user
router.get("/concierge/intro-steps", async (_req, res): Promise<void> => {
  const s = await getOrCreateSettings();
  res.json(parseSteps(s.conciergeIntroSteps));
});

// GET /api/admin/concierge-steps — admin/supervisor read
router.get("/admin/concierge-steps", requireRole("admin", "supervisor"), async (_req, res): Promise<void> => {
  const s = await getOrCreateSettings();
  res.json(parseSteps(s.conciergeIntroSteps));
});

// PUT /api/admin/concierge-steps — admin only
router.put("/admin/concierge-steps", requireRole("admin"), async (req, res): Promise<void> => {
  const body = req.body;
  if (!Array.isArray(body) || body.length === 0 || body.length > 8) {
    res.status(400).json({ error: "steps must be an array of 1–8 items" });
    return;
  }
  for (const step of body) {
    if (typeof step.emoji !== "string" || typeof step.title !== "string" || typeof step.body !== "string" || typeof step.cta !== "string") {
      res.status(400).json({ error: "each step must have emoji, title, body, and cta strings" });
      return;
    }
  }
  const existing = await getOrCreateSettings();
  const [updated] = await db.update(adminSettingsTable)
    .set({ conciergeIntroSteps: JSON.stringify(body) })
    .where(eq(adminSettingsTable.id, existing.id))
    .returning();
  res.json(parseSteps(updated.conciergeIntroSteps));
});

export { getOrCreateSettings, getDecryptedWooCreds };
export default router;
