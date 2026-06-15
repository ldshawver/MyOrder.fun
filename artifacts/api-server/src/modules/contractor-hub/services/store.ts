import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, contractsTable, contractSignersTable, contractAuditLogsTable, documensoWebhookEventsTable } from "@workspace/db";
import { createSigningToken, hashSigningToken } from "../signing/tokens";

export type SignerStatus = "pending" | "sent" | "viewed" | "signed" | "declined" | "expired" | "replaced";
export type ContractSigner = typeof contractSignersTable.$inferSelect;
export type Contract = typeof contractsTable.$inferSelect;
export const testContracts = new Map<string, Contract>();
export const testSigners = new Map<string, ContractSigner>();
export const testContractAuditLogs: (typeof contractAuditLogsTable.$inferSelect)[] = [];
export const testWebhookEvents = new Set<string>();
const useTestStore = () => process.env.NODE_ENV === "test";

export async function listContracts(): Promise<Contract[]> {
  if (useTestStore()) return [...testContracts.values()];
  return db.select().from(contractsTable);
}

export async function writeContractAudit(input: { contractId: string; companyId: string; action: string; actorUserId?: string; actorEmail?: string; beforeJson?: unknown; afterJson?: unknown }): Promise<void> {
  const row = { id: `contract_audit_${crypto.randomUUID()}`, contractId: input.contractId, companyId: input.companyId, actorUserId: input.actorUserId, actorEmail: input.actorEmail, action: input.action, beforeJson: input.beforeJson, afterJson: input.afterJson };
  if (useTestStore()) { testContractAuditLogs.push({ ...row, createdAt: new Date() } as typeof contractAuditLogsTable.$inferSelect); return; }
  await db.insert(contractAuditLogsTable).values(row);
}

export async function recordDocumensoWebhookEvent(input: { eventId: string; contractId?: string; documensoDocumentId?: string; eventType: string; payload: unknown }): Promise<boolean> {
  if (useTestStore()) { if (testWebhookEvents.has(input.eventId)) return false; testWebhookEvents.add(input.eventId); return true; }
  try {
    await db.insert(documensoWebhookEventsTable).values({ id: `documenso_event_${crypto.randomUUID()}`, eventId: input.eventId, contractId: input.contractId, documensoDocumentId: input.documensoDocumentId, eventType: input.eventType, payload: input.payload });
    return true;
  } catch {
    return false;
  }
}

export async function getContract(id: string): Promise<Contract | undefined> {
  if (useTestStore()) return testContracts.get(id);
  const [row] = await db.select().from(contractsTable).where(eq(contractsTable.id, id)).limit(1);
  return row;
}

export async function upsertContract(input: Partial<typeof contractsTable.$inferInsert> & { id: string }): Promise<Contract> {
  const value = { id: input.id, companyId: input.companyId ?? "company_1", title: input.title ?? "Service Agreement", contractorId: input.contractorId, approvedProposalContractorUserId: input.approvedProposalContractorUserId, status: input.status ?? "ready_for_signature", documensoDocumentId: input.documensoDocumentId, storageKey: input.storageKey };
  if (useTestStore()) { const existing = testContracts.get(input.id); const merged = { ...existing, ...value, createdAt: existing?.createdAt ?? new Date(), updatedAt: new Date() } as Contract; testContracts.set(input.id, merged); return merged; }
  const [row] = await db.insert(contractsTable).values(value).onConflictDoUpdate({ target: contractsTable.id, set: { ...value, updatedAt: new Date() } }).returning();
  return row;
}

export async function ensureContract(id: string): Promise<Contract> { return (await getContract(id)) ?? upsertContract({ id }); }

export async function listSigners(contractId: string): Promise<ContractSigner[]> {
  if (useTestStore()) return [...testSigners.values()].filter((s) => s.contractId === contractId);
  return db.select().from(contractSignersTable).where(eq(contractSignersTable.contractId, contractId));
}

export async function addSigner(input: Partial<typeof contractSignersTable.$inferInsert> & { contractId: string; email: string; name?: string | null }): Promise<{ signer: ContractSigner; token: string }> {
  const token = createSigningToken();
  const contract = await ensureContract(input.contractId);
  const value = { id: input.id ?? `signer_${crypto.randomUUID()}`, contractId: input.contractId, companyId: input.companyId ?? contract.companyId, contractorId: input.contractorId, userId: input.userId, email: input.email.toLowerCase(), name: input.name ?? input.email, signerRole: input.signerRole ?? "signer", signerType: input.signerType ?? "external", isRequired: input.isRequired ?? true, isDelegated: input.isDelegated ?? false, delegatedByUserId: input.delegatedByUserId, replacesSignerId: input.replacesSignerId, signingOrder: input.signingOrder ?? 1, status: input.status ?? "pending", documensoRecipientId: input.documensoRecipientId, signingTokenHash: hashSigningToken(token), signingTokenExpiresAt: input.signingTokenExpiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), signedAt: input.signedAt };
  if (useTestStore()) { const signer = { ...value, createdAt: new Date(), updatedAt: new Date() } as ContractSigner; testSigners.set(signer.id, signer); return { signer, token }; }
  const [signer] = await db.insert(contractSignersTable).values(value).returning();
  return { signer, token };
}

export async function findSignerByToken(token: string): Promise<ContractSigner | undefined> {
  const hash = hashSigningToken(token);
  if (useTestStore()) return [...testSigners.values()].find((s) => s.signingTokenHash === hash);
  const [row] = await db.select().from(contractSignersTable).where(eq(contractSignersTable.signingTokenHash, hash)).limit(1);
  return row;
}

export async function updateSignerStatus(id: string, status: SignerStatus): Promise<ContractSigner | undefined> {
  const patch = { status, signedAt: status === "signed" ? new Date() : undefined, updatedAt: new Date() };
  if (useTestStore()) { const current = testSigners.get(id); if (!current) return undefined; const next = { ...current, ...patch } as ContractSigner; testSigners.set(id, next); return next; }
  const [row] = await db.update(contractSignersTable).set(patch).where(eq(contractSignersTable.id, id)).returning();
  return row;
}

export async function findSignerByDocumensoRecipient(contractId: string, recipientId: string): Promise<ContractSigner | undefined> {
  if (useTestStore()) return [...testSigners.values()].find((s) => s.contractId === contractId && s.documensoRecipientId === recipientId);
  const [row] = await db.select().from(contractSignersTable).where(and(eq(contractSignersTable.contractId, contractId), eq(contractSignersTable.documensoRecipientId, recipientId))).limit(1);
  return row;
}
