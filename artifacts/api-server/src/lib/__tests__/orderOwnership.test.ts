import { describe, expect, it } from "vitest";
import { assertOrderOwnership, orderOwnerColumns } from "../orderOwnership";

describe("server-only checkout ownership", () => {
  it("requires a registered customer as the immutable order owner", () => {
    const ownership = {
      kind: "authenticated_customer" as const,
      tenantId: 7,
      customerUserId: 71,
      conversionSubjectUserId: 71,
    };
    expect(orderOwnerColumns(ownership)).toEqual({ customerId: 71, guestIdentityId: null });
  });

  it("rejects a missing customer or mismatched conversion subject", () => {
    expect(() => assertOrderOwnership({
      kind: "authenticated_customer", tenantId: 7, customerUserId: 71,
      conversionSubjectUserId: 20,
    })).toThrow("Invalid authenticated checkout ownership");
    expect(() => assertOrderOwnership({
      kind: "authenticated_customer", tenantId: 7, customerUserId: 0,
      conversionSubjectUserId: 0,
    })).toThrow("Invalid authenticated checkout ownership");
  });
});
