import { Router, type IRouter, type Request } from "express";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, writeAuditLog } from "../lib/auth";
import { hasPermission } from "../lib/roles";
import { createBusinessSettingsPatchSchema } from "../config/configSchemas";
import { changedBusinessFieldNames, compactUserAgent, hashForAudit } from "../config/configRedaction";
import { getTenantSettings, updateTenantBusinessSettings } from "../config/tenantConfig";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

function actorTenantId(req: Request): number | null {
  const tenantId = req.dbUser?.tenantId;
  return Number.isInteger(tenantId) && Number(tenantId) > 0 ? Number(tenantId) : null;
}

function runtimeEnvironment(): string {
  return process.env.NODE_ENV ?? "production";
}

function zodError(error: { issues?: Array<{ path: Array<string | number>; message: string }> }) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues ?? []) {
    const path = issue.path.join(".") || "root";
    fieldErrors[path] = issue.message;
  }
  return fieldErrors;
}

router.get("/settings", async (req, res): Promise<void> => {
  const tenantId = actorTenantId(req);
  if (!tenantId) {
    res.status(403).json({ error: "Tenant-scoped settings require an assigned tenant" });
    return;
  }
  if (!(await hasPermission(req.dbUser, "settings.view", tenantId))) {
    res.status(403).json({ error: "Forbidden: missing permission", permission: "settings.view" });
    return;
  }
  const settings = await getTenantSettings(tenantId);
  if (!settings) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(settings);
});

router.patch("/settings/business", async (req, res): Promise<void> => {
  const tenantId = actorTenantId(req);
  if (!tenantId) {
    res.status(403).json({ error: "Tenant-scoped settings require an assigned tenant" });
    return;
  }
  if (!(await hasPermission(req.dbUser, "settings.edit_business", tenantId))) {
    res.status(403).json({ error: "Forbidden: missing permission", permission: "settings.edit_business" });
    return;
  }

  const parsed = createBusinessSettingsPatchSchema({ runtimeEnvironment: runtimeEnvironment() }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid business settings", fieldErrors: zodError(parsed.error) });
    return;
  }

  const changedFields = changedBusinessFieldNames(parsed.data as Record<string, unknown>);
  const result = await updateTenantBusinessSettings({ tenantId, actorUserId: req.dbUser!.id, patch: parsed.data });
  if (result.missing) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  if (result.stale || !result.updated) {
    const latest = await getTenantSettings(tenantId);
    res.status(409).json({ error: "Business settings version is stale", currentVersion: latest?.business.version ?? null, settings: latest });
    return;
  }

  await writeAuditLog({
    actorId: req.dbUser!.id,
    actorEmail: req.dbUser!.email,
    actorRole: req.dbUser!.role,
    tenantId,
    action: "tenant_settings.business_updated",
    resourceType: "tenant_settings",
    resourceId: String(tenantId),
    metadata: {
      changedFields,
      requestId: req.id,
      payloadHash: hashForAudit({ version: parsed.data.version, changedFields }),
      userAgent: compactUserAgent(req.get("user-agent")),
    },
  });

  res.json(result.updated);
});

export default router;
