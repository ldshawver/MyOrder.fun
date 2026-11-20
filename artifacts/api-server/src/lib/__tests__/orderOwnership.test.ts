import { describe, expect, it } from "vitest";
import { assertOrderOwnership, orderOwnerColumns } from "../orderOwnership";

describe("server-only checkout ownership", () => {
  it("keeps a guest identity distinct from the staff actor", () => {
    const ownership = {
      kind: "guest" as const,
      tenantId: 7,
      guestIdentityId: 71,
      staffActorUserId: 19,
      conversionSubjectUserId: 19,
      shiftId: 31,
      generalCashSessionId: null,
    };
    expect(orderOwnerColumns(ownership)).toEqual({ customerId: null, guestIdentityId: 71 });
  });

  it("rejects an ambiguous cash context or a mismatched conversion subject", () => {
    expect(() => assertOrderOwnership({
      kind: "guest", tenantId: 7, guestIdentityId: 71, staffActorUserId: 19,
      conversionSubjectUserId: 20, shiftId: 31, generalCashSessionId: null,
    })).toThrow("Invalid guest checkout ownership");
    expect(() => assertOrderOwnership({
      kind: "guest", tenantId: 7, guestIdentityId: 71, staffActorUserId: 19,
      conversionSubjectUserId: 19, shiftId: 31, generalCashSessionId: 9,
    })).toThrow("Invalid guest checkout ownership");
  });
});
