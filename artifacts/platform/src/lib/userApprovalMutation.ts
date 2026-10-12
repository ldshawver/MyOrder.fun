import type { SetUserApprovalBody, SetUserApprovalResponse } from "@workspace/api-client-react";

export type ApprovalErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "OWNER_AUTH_REQUIRED"
  | "RECENT_AUTH_REQUIRED"
  | "APPROVAL_TARGET_UNAVAILABLE"
  | "ROLE_ASSIGNMENT_DENIED"
  | "INVALID_APPROVAL_REQUEST"
  | "APPROVAL_STATE_CONFLICT";

export class ApprovalMutationError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super("Approval request failed");
    this.name = "ApprovalMutationError";
  }
}

type ReverificationHint = {
  code: "RECENT_AUTH_REQUIRED";
  clerk_error: { type: "forbidden"; reason: "reverification-error"; metadata?: unknown };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReverificationHint(value: unknown): value is ReverificationHint {
  if (!isRecord(value) || value.code !== "RECENT_AUTH_REQUIRED" || !isRecord(value.clerk_error)) return false;
  return value.clerk_error.type === "forbidden" && value.clerk_error.reason === "reverification-error";
}

/** Fetcher for Clerk's useReverification wrapper. It returns only the Clerk
 * step-up hint; all other non-2xx responses remain rejected mutations. */
export async function requestUserApproval(
  id: number,
  data: SetUserApprovalBody,
  fetcher: typeof fetch = fetch,
): Promise<SetUserApprovalResponse | ReverificationHint> {
  const response = await fetcher(`/api/admin/users/${id}/approval`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(data),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.status === 403 && isReverificationHint(payload)) return payload;
  const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : undefined;
  if (!response.ok) throw new ApprovalMutationError(response.status, code);
  if (!isRecord(payload) || payload.status !== "approved") {
    throw new ApprovalMutationError(502, "INVALID_APPROVAL_RESPONSE");
  }
  return payload as unknown as SetUserApprovalResponse;
}

export function approvalMutationFailureMessage(error: unknown): string {
  if (error instanceof ApprovalMutationError) {
    switch (error.code) {
      case "AUTHENTICATION_REQUIRED": return "Your sign-in is no longer valid. Sign in again, then retry.";
      case "OWNER_AUTH_REQUIRED": return "This action is restricted to the configured account owner.";
      case "RECENT_AUTH_REQUIRED": return "Recent verification was not completed. Verify your identity, then retry.";
      case "APPROVAL_TARGET_UNAVAILABLE": return "This account is unavailable in your management scope.";
      case "ROLE_ASSIGNMENT_DENIED": return "You cannot assign that role. Choose a role available to your account.";
      case "INVALID_APPROVAL_REQUEST": return "The approval request was invalid. Refresh the page and try again.";
      case "APPROVAL_STATE_CONFLICT": return "The account changed before approval completed. Refresh the user list.";
    }
    if (error.status === 401) return "Your sign-in is no longer valid. Sign in again, then retry.";
    if (error.status >= 500) return "The server could not confirm the result. Refresh the user list before retrying.";
    return "Approval was not completed. Refresh the user list and check your permissions.";
  }

  if (isRecord(error) && error.code === "reverification_cancelled") {
    return "Identity verification was cancelled. Approval was not retried.";
  }
  if (error instanceof TypeError) {
    return "The connection failed. Refresh the user list before retrying to confirm the account status.";
  }
  return "The result could not be confirmed. Refresh the user list before retrying.";
}

export function isApprovalReverificationHint(value: unknown): value is ReverificationHint {
  return isReverificationHint(value);
}
