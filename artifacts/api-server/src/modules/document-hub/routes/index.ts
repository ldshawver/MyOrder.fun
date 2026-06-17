import { Router, type NextFunction, type Request, type Response } from "express";
import { loadDbUser, normalizeRole, requireApproved, requireAuth, requireDbUser } from "../../../lib/auth";
import {
  addDocumentVersion,
  archiveDocument,
  canAccessDocument,
  createDocumentAsset,
  getDocumentAsset,
  getDocumentMetadata,
  listDocumentAssets,
  listDocumentAudit,
  upsertMetadata,
  writeDocumentAudit,
  type DocumentAsset,
} from "../services/store";

const router = Router();

type DocumentAction =
  | "list"
  | "create"
  | "view"
  | "download"
  | "print"
  | "editMetadata"
  | "version"
  | "archive"
  | "audit";

type Actor = {
  id: string;
  email: string | null;
  role: string;
  normalizedRole: ReturnType<typeof normalizeRole>;
  tenantId: string | null;
};

router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

function getActor(req: Request): Actor {
  const user = req.dbUser;
  if (!user) throw new Error("Document Hub actor was not loaded");
  return {
    id: String(user.id),
    email: user.email ?? null,
    role: user.role,
    normalizedRole: normalizeRole(user.role),
    tenantId: user.tenantId == null ? null : String(user.tenantId),
  };
}

function isGlobalAdmin(actor: Actor): boolean {
  return actor.normalizedRole === "global_admin";
}

function isTenantAdmin(actor: Actor): boolean {
  const rawRole = actor.role.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return actor.normalizedRole === "admin" && rawRole !== "supervisor";
}

function sameTenant(actor: Actor, asset: Pick<DocumentAsset, "companyId">): boolean {
  return isGlobalAdmin(actor) || (!!actor.tenantId && actor.tenantId === asset.companyId);
}

async function canUseAsset(actor: Actor, asset: DocumentAsset, action: Exclude<DocumentAction, "list" | "create">): Promise<boolean> {
  if (isGlobalAdmin(actor)) return true;
  if (isTenantAdmin(actor)) return sameTenant(actor, asset);
  if (actor.role.trim().toLowerCase().replace(/[\s-]+/g, "_") === "supervisor") {
    if (!sameTenant(actor, asset)) return false;
    if (action !== "view" && action !== "download" && action !== "print" && action !== "editMetadata") return false;
    return canAccessDocument(asset, action, { id: actor.id, role: "supervisor", companyId: actor.tenantId ?? undefined });
  }
  if (action !== "view" && action !== "download" && action !== "print" && action !== "editMetadata") return false;
  return canAccessDocument(asset, action, { id: actor.id, role: actor.role, companyId: actor.tenantId ?? undefined });
}

function deny(res: Response): void {
  res.status(403).json({ error: "Forbidden: insufficient document permissions" });
}

async function loadAuthorizedAsset(
  req: Request,
  res: Response,
  action: Exclude<DocumentAction, "list" | "create">,
): Promise<DocumentAsset | null> {
  const asset = await getDocumentAsset(String(req.params.id));
  if (!asset) {
    res.status(404).json({ error: "Document not found" });
    return null;
  }
  if (!(await canUseAsset(getActor(req), asset, action))) {
    deny(res);
    return null;
  }
  return asset;
}

function requireDocumentManager(req: Request, res: Response, next: NextFunction): void {
  const actor = getActor(req);
  if (!isGlobalAdmin(actor) && !isTenantAdmin(actor)) {
    deny(res);
    return;
  }
  next();
}

router.get("/document-hub/assets", async (req, res): Promise<void> => {
  const actor = getActor(req);
  const assets = await listDocumentAssets(String(req.query.q ?? ""));
  if (isGlobalAdmin(actor)) {
    res.json({ assets });
    return;
  }
  if (isTenantAdmin(actor) && actor.tenantId) {
    res.json({ assets: assets.filter((asset) => asset.companyId === actor.tenantId) });
    return;
  }
  res.json({ assets: [] });
});

router.post("/document-hub/assets", requireDocumentManager, async (req, res): Promise<void> => {
  const actor = getActor(req);
  const companyId = String(req.body?.companyId ?? actor.tenantId ?? "");
  if (!companyId || (!isGlobalAdmin(actor) && companyId !== actor.tenantId)) {
    deny(res);
    return;
  }
  res.status(201).json({
    asset: await createDocumentAsset({ ...req.body, companyId, createdByUserId: actor.id }),
  });
});

router.get("/document-hub/assets/:id", async (req, res): Promise<void> => {
  const asset = await loadAuthorizedAsset(req, res, "view");
  if (!asset) return;
  res.json({ asset, metadata: await getDocumentMetadata(asset.id) });
});

router.get("/document-hub/assets/:id/download", async (req, res): Promise<void> => {
  const actor = getActor(req);
  const asset = await loadAuthorizedAsset(req, res, "download");
  if (!asset) return;
  await writeDocumentAudit({ documentAssetId: asset.id, companyId: asset.companyId, actorUserId: actor.id, actorEmail: actor.email ?? undefined, action: "downloaded", afterJson: { documentAssetId: asset.id } });
  res.json({ downloadUrl: `/api/document-hub/assets/${asset.id}/download/file`, asset });
});

router.get("/document-hub/assets/:id/print", async (req, res): Promise<void> => {
  const actor = getActor(req);
  const asset = await loadAuthorizedAsset(req, res, "print");
  if (!asset) return;
  await writeDocumentAudit({ documentAssetId: asset.id, companyId: asset.companyId, actorUserId: actor.id, actorEmail: actor.email ?? undefined, action: "printed", afterJson: { documentAssetId: asset.id } });
  res.json({ printUrl: `/api/document-hub/assets/${asset.id}/print/file`, asset });
});

router.patch("/document-hub/assets/:id/metadata", async (req, res): Promise<void> => {
  const actor = getActor(req);
  const asset = await loadAuthorizedAsset(req, res, "editMetadata");
  if (!asset) return;
  const metadata = await upsertMetadata(asset.id, req.body);
  await writeDocumentAudit({ documentAssetId: asset.id, companyId: asset.companyId, actorUserId: actor.id, actorEmail: actor.email ?? undefined, action: "metadata_updated", afterJson: { metadataKeys: Object.keys(req.body ?? {}) } });
  res.json({ metadata });
});

router.post("/document-hub/assets/:id/versions", requireDocumentManager, async (req, res): Promise<void> => {
  const actor = getActor(req);
  const asset = await loadAuthorizedAsset(req, res, "version");
  if (!asset) return;
  const version = await addDocumentVersion(asset, { ...req.body, createdByUserId: actor.id });
  await writeDocumentAudit({ documentAssetId: asset.id, companyId: asset.companyId, actorUserId: actor.id, actorEmail: actor.email ?? undefined, action: "version_created", afterJson: { versionNumber: version.versionNumber, changeSummary: version.changeSummary } });
  res.status(201).json({ version });
});

router.post("/document-hub/assets/:id/archive", requireDocumentManager, async (req, res): Promise<void> => {
  const actor = getActor(req);
  const asset = await loadAuthorizedAsset(req, res, "archive");
  if (!asset) return;
  const archived = await archiveDocument(asset);
  await writeDocumentAudit({ documentAssetId: asset.id, companyId: asset.companyId, actorUserId: actor.id, actorEmail: actor.email ?? undefined, action: "archived", afterJson: { documentAssetId: asset.id, status: archived.status } });
  res.json({ asset: archived });
});

router.get("/document-hub/assets/:id/audit", requireDocumentManager, async (req, res): Promise<void> => {
  const asset = await loadAuthorizedAsset(req, res, "audit");
  if (!asset) return;
  res.json({ auditLogs: await listDocumentAudit(String(req.params.id)) });
});

export default router;
