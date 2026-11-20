/**
 * Server-only ownership context for checkout creation.  It deliberately
 * separates who owns an order from the authenticated actor performing an
 * authorized staff-assisted sale.
 */
export type OrderOwnership = {
  kind: "authenticated_customer";
  tenantId: number;
  customerUserId: number;
  conversionSubjectUserId: number;
};

export function assertOrderOwnership(input: OrderOwnership): void {
  if (!Number.isSafeInteger(input.customerUserId) || input.customerUserId <= 0 || input.conversionSubjectUserId !== input.customerUserId) {
    throw new Error("Invalid authenticated checkout ownership");
  }
}

export function orderOwnerColumns(input: OrderOwnership): { customerId: number; guestIdentityId: null } {
  assertOrderOwnership(input);
  return { customerId: input.customerUserId, guestIdentityId: null };
}
