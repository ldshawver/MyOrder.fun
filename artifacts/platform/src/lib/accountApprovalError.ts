export type AccountApprovalScreenStatus = "pending" | "rejected";

type ApiError = {
  status?: number;
  data?: { code?: string };
} | null | undefined;

/** Returns an account review state only for explicit approval-gate responses. */
export function getAccountApprovalScreenStatus(error: ApiError): AccountApprovalScreenStatus | null {
  if (error?.status !== 403) return null;
  if (error.data?.code === "ACCOUNT_PENDING_APPROVAL") return "pending";
  if (error.data?.code === "ACCOUNT_REJECTED") return "rejected";
  return null;
}
