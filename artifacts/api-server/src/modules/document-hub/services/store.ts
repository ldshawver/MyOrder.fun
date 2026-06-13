import crypto from "node:crypto";
import { eq, ilike, or } from "drizzle-orm";
import { db, documentAssetAuditLogsTable, documentAssetMetadataTable, documentAssetVersionsTable, documentAssetsTable, documentAssetPermissionsTable } from "@workspace/db";

export type DocumentAsset = typeof documentAssetsTable.$inferSelect;
export type DocumentPermission = typeof documentAssetPermissionsTable.$inferSelect;
export const testDocumentAssets = new Map<string, DocumentAsset>();
export const testDocumentMetadata = new Map<string, Record<string, string>>();
export const testDocumentPermissions: DocumentPermission[] = [];
export const testDocumentAuditLogs: (typeof documentAssetAuditLogsTable.$inferSelect)[] = [];
const useTestStore = () => process.env.NODE_ENV === "test";
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export async function listDocumentAssets(q = ""): Promise<DocumentAsset[]> {
  if (useTestStore()) return [...testDocumentAssets.values()].filter((a) => !q || a.title.toLowerCase().includes(q.toLowerCase()) || a.documentType.toLowerCase().includes(q.toLowerCase()));
  if (!q) return db.select().from(documentAssetsTable);
  return db.select().from(documentAssetsTable).where(or(ilike(documentAssetsTable.title, `%${q}%`), ilike(documentAssetsTable.documentType, `%${q}%`)));
}

export async function getDocumentAsset(assetId: string): Promise<DocumentAsset | undefined> {
  if (useTestStore()) return testDocumentAssets.get(assetId);
  const [asset] = await db.select().from(documentAssetsTable).where(eq(documentAssetsTable.id, assetId)).limit(1);
  return asset;
}

export async function getDocumentMetadata(assetId: string): Promise<Record<string, string>> {
  if (useTestStore()) return testDocumentMetadata.get(assetId) ?? {};
  const rows = await db.select().from(documentAssetMetadataTable).where(eq(documentAssetMetadataTable.documentAssetId, assetId));
  return Object.fromEntries(rows.map((r) => [r.metadataKey, r.metadataValue ?? ""]));
}

export async function createDocumentAsset(input: Partial<typeof documentAssetsTable.$inferInsert> & { companyId: string; title: string; fileName: string; documentType: string }): Promise<DocumentAsset> {
  const now = new Date();
  const asset = { id: input.id ?? id("doc"), companyId: input.companyId, ownerUserId: input.ownerUserId, relatedEmployeeId: input.relatedEmployeeId, relatedContractorId: input.relatedContractorId, relatedProposalId: input.relatedProposalId, relatedContractId: input.relatedContractId, relatedInvoiceId: input.relatedInvoiceId, sourceModule: input.sourceModule ?? "document_hub", sourceType: input.sourceType, documentType: input.documentType, title: input.title, description: input.description, fileName: input.fileName, fileMimeType: input.fileMimeType ?? "application/pdf", fileSize: input.fileSize ?? 0, storageProvider: input.storageProvider ?? "local", storageKey: input.storageKey ?? input.fileName, publicUrl: input.publicUrl, signedUrl: input.signedUrl, status: input.status ?? "active", versionNumber: input.versionNumber ?? 1, isFinal: input.isFinal ?? false, isArchived: input.isArchived ?? false, createdByUserId: input.createdByUserId, archivedAt: input.archivedAt };
  if (useTestStore()) { const row = { ...asset, createdAt: now, updatedAt: now } as DocumentAsset; testDocumentAssets.set(row.id, row); testDocumentAuditLogs.push({ id: id("audit"), documentAssetId: row.id, companyId: row.companyId, actorUserId: row.createdByUserId, actorEmail: null, action: "created", beforeJson: null, afterJson: row, ipAddress: null, userAgent: null, createdAt: now }); return row; }
  const [row] = await db.insert(documentAssetsTable).values(asset).returning();
  await writeDocumentAudit({ documentAssetId: row.id, companyId: row.companyId, actorUserId: row.createdByUserId ?? undefined, action: "created", afterJson: row });
  return row;
}

export async function writeDocumentAudit(input: { documentAssetId: string; companyId: string; actorUserId?: string; actorEmail?: string; action: string; beforeJson?: unknown; afterJson?: unknown; ipAddress?: string; userAgent?: string }) {
  const row = { id: id("audit"), documentAssetId: input.documentAssetId, companyId: input.companyId, actorUserId: input.actorUserId, actorEmail: input.actorEmail, action: input.action, beforeJson: input.beforeJson, afterJson: input.afterJson, ipAddress: input.ipAddress, userAgent: input.userAgent };
  if (useTestStore()) { testDocumentAuditLogs.push({ ...row, createdAt: new Date() } as typeof documentAssetAuditLogsTable.$inferSelect); return; }
  await db.insert(documentAssetAuditLogsTable).values(row);
}

export async function canAccessDocument(asset: DocumentAsset, action: "view"|"download"|"print"|"editMetadata", user?: { id?: string; role?: string; companyId?: string }): Promise<boolean> {
  if (user?.companyId === asset.companyId && (user.role === "admin" || user.role === "global_admin")) return true;
  if (user?.id && asset.ownerUserId === user.id) return true;
  const perms = useTestStore() ? testDocumentPermissions.filter((p) => p.documentAssetId === asset.id) : await db.select().from(documentAssetPermissionsTable).where(eq(documentAssetPermissionsTable.documentAssetId, asset.id));
  const perm = perms.find((p) => (!p.expiresAt || p.expiresAt > new Date()) && ((user?.id && p.userId === user.id) || (user?.role && p.role === user.role)));
  if (!perm) return false;
  if (action === "view") return perm.permissionView;
  if (action === "download") return perm.permissionDownload;
  if (action === "print") return perm.permissionPrint;
  return perm.permissionEditMetadata;
}

export async function upsertMetadata(assetId: string, values: Record<string, string>): Promise<Record<string, string>> {
  if (useTestStore()) { const next = { ...(testDocumentMetadata.get(assetId) ?? {}), ...values }; testDocumentMetadata.set(assetId, next); return next; }
  for (const [metadataKey, metadataValue] of Object.entries(values)) await db.insert(documentAssetMetadataTable).values({ id: id("meta"), documentAssetId: assetId, metadataKey, metadataValue, metadataType: "string" });
  return getDocumentMetadata(assetId);
}

export async function addDocumentVersion(asset: DocumentAsset, input: { storageKey?: string; fileName?: string; fileMimeType?: string; fileSize?: number; createdByUserId?: string; changeSummary?: string }) {
  const versionNumber = asset.versionNumber + 1;
  if (useTestStore()) testDocumentAssets.set(asset.id, { ...asset, versionNumber, updatedAt: new Date() });
  else await db.update(documentAssetsTable).set({ versionNumber, updatedAt: new Date() }).where(eq(documentAssetsTable.id, asset.id));
  const version = { id: id("version"), documentAssetId: asset.id, versionNumber, storageKey: input.storageKey ?? asset.storageKey, fileName: input.fileName ?? asset.fileName, fileMimeType: input.fileMimeType ?? asset.fileMimeType, fileSize: input.fileSize ?? asset.fileSize, createdByUserId: input.createdByUserId, changeSummary: input.changeSummary };
  if (!useTestStore()) await db.insert(documentAssetVersionsTable).values(version);
  return version;
}

export async function archiveDocument(asset: DocumentAsset): Promise<DocumentAsset> {
  const patch = { isArchived: true, archivedAt: new Date(), status: "archived", updatedAt: new Date() };
  if (useTestStore()) { const next = { ...asset, ...patch }; testDocumentAssets.set(asset.id, next); return next; }
  const [row] = await db.update(documentAssetsTable).set(patch).where(eq(documentAssetsTable.id, asset.id)).returning();
  return row;
}

export async function archiveContractDocument(input: { companyId: string; contractId: string; title: string; fileName: string; storageKey?: string; documensoDocumentId?: string; signerEmail?: string }) {
  const asset = await createDocumentAsset({ companyId: input.companyId, relatedContractId: input.contractId, sourceModule: "contractor_hub", sourceType: "contract", documentType: "signed_contract", title: input.title, fileName: input.fileName, storageKey: input.storageKey ?? input.fileName, isFinal: true, isArchived: true, status: "archived", archivedAt: new Date() });
  await upsertMetadata(asset.id, { documenso_document_id: input.documensoDocumentId ?? "", documenso_signer_email: input.signerEmail ?? "", source_module: "contractor_hub", document_type: "signed_contract" });
  await writeDocumentAudit({ documentAssetId: asset.id, companyId: asset.companyId, action: "contract_archived", afterJson: { contractId: input.contractId } });
  return asset;
}

export async function listDocumentAudit(assetId: string) {
  if (useTestStore()) return testDocumentAuditLogs.filter((l) => l.documentAssetId === assetId);
  return db.select().from(documentAssetAuditLogsTable).where(eq(documentAssetAuditLogsTable.documentAssetId, assetId));
}
