import { describe, expect, it } from "vitest";
import { getAccountApprovalScreenStatus } from "../accountApprovalError";

describe("account approval error routing", () => {
  it("shows pending review only for an explicit pending approval response", () => {
    expect(getAccountApprovalScreenStatus({ status: 403, data: { code: "ACCOUNT_PENDING_APPROVAL" } })).toBe("pending");
  });

  it("shows rejection only for an explicit rejected approval response", () => {
    expect(getAccountApprovalScreenStatus({ status: 403, data: { code: "ACCOUNT_REJECTED" } })).toBe("rejected");
  });

  it.each([
    { status: 403, data: {} },
    { status: 403, data: { code: "ACCOUNT_APPROVAL_PROVENANCE_REQUIRED" } },
    { status: 403, data: { code: "FORBIDDEN" } },
    { status: 401, data: { code: "ACCOUNT_PENDING_APPROVAL" } },
  ])("does not reinterpret unrelated errors as pending or rejected: %o", (error) => {
    expect(getAccountApprovalScreenStatus(error)).toBeNull();
  });
});
