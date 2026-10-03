import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { adminSettingsTable, db, tenantsTable } from "@workspace/db";
import { encrypt, hasConfiguredSettingsEncryptionKey, safeDecrypt } from "../lib/crypto";
import { loadPaymentConfig, PaymentConfigurationError, type PaymentConfig } from "./config";

const storedSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  environment: z.enum(["sandbox", "live"]),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  webhookId: z.string().trim().min(1),
}).strict();
type Stored = z.infer<typeof storedSchema>;

function processorDocument(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* fail closed below */ }
  throw new PaymentConfigurationError("Invalid tenant processor configuration");
}

function readStored(raw: string | null): Stored | null {
  const ciphertext = processorDocument(raw).paypalRuntimeCiphertext;
  if (ciphertext === undefined) return null;
  if (typeof ciphertext !== "string" || !ciphertext.startsWith("enc:v1:")) throw new PaymentConfigurationError("Invalid encrypted PayPal configuration");
  const plaintext = safeDecrypt(ciphertext);
  if (!plaintext) throw new PaymentConfigurationError("PayPal configuration cannot be decrypted");
  try { return storedSchema.parse(JSON.parse(plaintext)); }
  catch { throw new PaymentConfigurationError("Invalid tenant PayPal configuration"); }
}

async function tenantRow(tenantId: number) {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new PaymentConfigurationError("Tenant is required for PayPal configuration");
  const [row] = await db.select({ processor: adminSettingsTable.merchantProcessorConfig })
    .from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, tenantId)).limit(1);
  return row?.processor ?? null;
}

export async function getTenantPayPalStatus(tenantId: number) {
  const stored = readStored(await tenantRow(tenantId));
  const config = await loadTenantPaymentConfig(tenantId);
  return {
    enabled: config.enabled,
    environment: stored?.environment ?? (config.enabled ? config.environment : "disabled"),
    clientIdConfigured: Boolean(stored?.clientId) || config.enabled,
    clientSecretConfigured: Boolean(stored?.clientSecret) || config.enabled,
    webhookIdConfigured: Boolean(stored?.webhookId) || config.enabled,
  } as const;
}

export async function loadTenantPaymentConfig(tenantId: number): Promise<PaymentConfig> {
  const stored = readStored(await tenantRow(tenantId));
  if (!stored) {
    // Preserve the historical deployment-secret configuration only for a
    // genuinely single-tenant installation. Never lend it to a second tenant.
    const tenants = await db.select({ id: tenantsTable.id }).from(tenantsTable).limit(2);
    return tenants.length === 1 && tenants[0].id === tenantId
      ? loadPaymentConfig()
      : { mode: "disabled", provider: "paypal", enabled: false };
  }
  if (!stored.enabled) return { mode: "disabled", provider: "paypal", enabled: false };
  return loadPaymentConfig({
    NODE_ENV: process.env.NODE_ENV,
    PAYMENT_PROVIDER: "paypal",
    PAYMENT_MODE: stored.environment,
    PAYPAL_ENVIRONMENT: stored.environment,
    PAYPAL_CLIENT_ID: stored.clientId,
    PAYPAL_CLIENT_SECRET: stored.clientSecret,
    PAYPAL_WEBHOOK_ID: stored.webhookId,
  });
}

export const paypalSettingsBody = z.object({
  enabled: z.boolean().optional(),
  environment: z.enum(["sandbox", "live"]).optional(),
  clientId: z.string().trim().min(1).max(300).optional(),
  clientSecret: z.string().trim().min(1).max(4096).optional(),
  webhookId: z.string().trim().min(1).max(300).optional(),
}).strict().refine(value => Object.keys(value).length > 0);
export type PayPalSettingsPatch = z.infer<typeof paypalSettingsBody>;

export async function saveTenantPayPalSettings(tenantId: number, patch: PayPalSettingsPatch) {
  if (!hasConfiguredSettingsEncryptionKey()) throw new PaymentConfigurationError("Tenant secret storage is unavailable");
  if (patch.environment === "live" && process.env.NODE_ENV !== "production") throw new PaymentConfigurationError("Live PayPal settings require production");
  return db.transaction(async tx => {
    await tx.insert(adminSettingsTable).values({ tenantId }).onConflictDoNothing({ target: adminSettingsTable.tenantId });
    const [row] = await tx.select().from(adminSettingsTable).where(and(eq(adminSettingsTable.tenantId, tenantId))).for("update").limit(1);
    if (!row) throw new PaymentConfigurationError("Tenant settings are unavailable");
    const document = processorDocument(row.merchantProcessorConfig);
    const prior = readStored(row.merchantProcessorConfig);
    if (prior && patch.environment && patch.environment !== prior.environment && (!patch.clientId || !patch.clientSecret || !patch.webhookId)) {
      throw new PaymentConfigurationError("Changing PayPal environment requires a complete new credential set");
    }
    if ((patch.clientId && !patch.clientSecret) || (patch.clientSecret && !patch.clientId)) {
      throw new PaymentConfigurationError("PayPal client ID and secret must be replaced together");
    }
    const next = storedSchema.parse({
      version: 1,
      enabled: patch.enabled ?? prior?.enabled ?? true,
      environment: patch.environment ?? prior?.environment,
      clientId: patch.clientId ?? prior?.clientId,
      clientSecret: patch.clientSecret ?? prior?.clientSecret,
      webhookId: patch.webhookId ?? prior?.webhookId,
    });
    if (next.environment === "live" && process.env.NODE_ENV !== "production") throw new PaymentConfigurationError("Live PayPal settings require production");
    document.paypalRuntimeCiphertext = encrypt(JSON.stringify(next));
    await tx.update(adminSettingsTable).set({ merchantProcessorConfig: JSON.stringify(document) })
      .where(eq(adminSettingsTable.id, row.id));
    return { enabled: next.enabled, environment: next.environment, clientIdConfigured: true, clientSecretConfigured: true, webhookIdConfigured: true } as const;
  });
}
