import { findSignerByToken, getContract, listSigners } from "../services/store";

export type CanSignContractInput = { contractId: string; userId?: string; email?: string; signingToken?: string; companyId?: string; role?: string; documensoRecipientId?: string };
export async function canSignContract(input: CanSignContractInput): Promise<boolean> {
  const contract = await getContract(input.contractId);
  if (!contract) return false;
  if ((input.role === "admin" || input.role === "global_admin") && input.companyId === contract.companyId) return true;
  const email = input.email?.toLowerCase();
  const signerRows = await listSigners(input.contractId);
  const assigned = signerRows.some((s) => s.status !== "expired" && s.status !== "replaced" && ((input.userId && s.userId === input.userId) || (email && s.email === email) || (input.documensoRecipientId && s.documensoRecipientId === input.documensoRecipientId)));
  if (assigned) return true;
  if (input.userId && contract.approvedProposalContractorUserId === input.userId) return true;
  if (input.signingToken) {
    const signer = await findSignerByToken(input.signingToken);
    return Boolean(signer && signer.contractId === input.contractId && signer.signingTokenExpiresAt && signer.signingTokenExpiresAt > new Date() && signer.status !== "expired" && signer.status !== "replaced");
  }
  return false;
}
