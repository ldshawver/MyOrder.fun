/**
 * Server-only ownership context for checkout creation.  It deliberately
 * separates who owns an order from the authenticated actor performing an
 * authorized staff-assisted sale.
 */
export type AuthenticatedOrderOwnership = {
  kind: "authenticated_customer";
  tenantId: number;
  customerUserId: number;
  conversionSubjectUserId: number;
};

export type GuestOrderOwnership = {
  kind: "guest";
  tenantId: number;
  guestIdentityId: number;
  staffActorUserId: number;
  conversionSubjectUserId: number;
  shiftId: number | null;
  generalCashSessionId: number | null;
};

export type OrderOwnership = AuthenticatedOrderOwnership | GuestOrderOwnership;

export function assertOrderOwnership(input: OrderOwnership): void {
  if (input.kind === "authenticated_customer") {
    if (!Number.isSafeInteger(input.customerUserId) || input.customerUserId <= 0 || input.conversionSubjectUserId !== input.customerUserId) {
      throw new Error("Invalid authenticated checkout ownership");
    }
    return;
  }
  if (!Number.isSafeInteger(input.guestIdentityId) || input.guestIdentityId <= 0
    || !Number.isSafeInteger(input.staffActorUserId) || input.staffActorUserId <= 0
    || input.conversionSubjectUserId !== input.staffActorUserId
    || (input.shiftId != null && input.generalCashSessionId != null)) {
    throw new Error("Invalid guest checkout ownership");
  }
}

export function orderOwnerColumns(input: OrderOwnership): { customerId: number | null; guestIdentityId: number | null } {
  assertOrderOwnership(input);
  return input.kind === "authenticated_customer"
    ? { customerId: input.customerUserId, guestIdentityId: null }
    : { customerId: null, guestIdentityId: input.guestIdentityId };
}
