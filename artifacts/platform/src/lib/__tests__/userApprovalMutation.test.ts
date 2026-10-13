import { describe, expect, it, vi } from "vitest";
import {
  approvalMutationFailureMessage,
  ApprovalMutationError,
  isApprovalReverificationHint,
  requestUserApproval,
} from "../userApprovalMutation";

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("owner approval mutation", () => {
  it("sends only the selected approval fields and accepts the authoritative approved response", async () => {
    const fetcher = vi.fn(async () => response(200, { id: 12, status: "approved", role: "csr" }));
    const result = await requestUserApproval(12, { approve: true, role: "csr" }, fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith("/api/admin/users/12/approval", expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
      body: JSON.stringify({ approve: true, role: "csr" }),
    }));
    expect(result).toMatchObject({ status: "approved" });
  });

  it("returns a Clerk reverification hint only for the explicit recent-auth denial", async () => {
    const hint = {
      code: "RECENT_AUTH_REQUIRED",
      clerk_error: { type: "forbidden", reason: "reverification-error", metadata: { reverification: { level: "first_factor", afterMinutes: 10 } } },
    };
    const result = await requestUserApproval(12, { approve: true, role: "user" }, async () => response(403, hint));
    expect(isApprovalReverificationHint(result)).toBe(true);
  });

  it.each([
    [401, "AUTHENTICATION_REQUIRED", "Sign in again"],
    [403, "OWNER_AUTH_REQUIRED", "configured account owner"],
    [404, "APPROVAL_TARGET_UNAVAILABLE", "unavailable in your management scope"],
    [403, "ROLE_ASSIGNMENT_DENIED", "cannot assign that role"],
    [400, "INVALID_APPROVAL_REQUEST", "request was invalid"],
    [409, "APPROVAL_STATE_CONFLICT", "changed before approval completed"],
  ])("surfaces safe guidance for %s %s", async (status, code, expected) => {
    await expect(requestUserApproval(12, { approve: true, role: "user" }, async () => response(status, { code })))
      .rejects.toMatchObject({ status, code });
    expect(approvalMutationFailureMessage(new ApprovalMutationError(status, code))).toContain(expected);
  });

  it("does not treat an unrelated 403 as a reverification request", async () => {
    await expect(requestUserApproval(12, { approve: true, role: "user" }, async () => response(403, { code: "ROLE_ASSIGNMENT_DENIED" })))
      .rejects.toMatchObject({ status: 403, code: "ROLE_ASSIGNMENT_DENIED" });
  });

  it("does not accept a success response unless the server confirms approved status", async () => {
    await expect(requestUserApproval(12, { approve: true, role: "user" }, async () => response(200, { id: 12, status: "pending" })))
      .rejects.toMatchObject({ status: 502, code: "INVALID_APPROVAL_RESPONSE" });
  });

  it("shows safe server and network failures without claiming an approval", async () => {
    const serverError = new ApprovalMutationError(500);
    expect(approvalMutationFailureMessage(serverError)).toContain("could not confirm the result");
    expect(approvalMutationFailureMessage(new TypeError("network unavailable"))).toContain("connection failed");
    const cancelled = Object.assign(new Error("verification cancelled"), { code: "reverification_cancelled" });
    expect(approvalMutationFailureMessage(cancelled)).toContain("Identity verification was cancelled");
  });
});
