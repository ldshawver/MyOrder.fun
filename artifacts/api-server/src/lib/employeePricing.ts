import { centsToDollars, dollarsToCents } from "./tenderTax";

/** Current employees pay 20% less when a product has no explicit employee price. */
export const EMPLOYEE_PERCENT_OFF = 20;

/**
 * The catalog dollar amount is the price a current employee pays for that
 * item. It replaces the 20% discount. A blank amount means 20% off retail.
 * Anyone who is not a current employee pays retail.
 */
export function resolveEmployeeUnitPriceCents(
  retail: string | number | null | undefined,
  employeePrice: string | number | null | undefined,
  isCurrentEmployee: boolean,
): number {
  const retailCents = dollarsToCents(retail);
  if (!isCurrentEmployee) return retailCents;
  if (employeePrice == null || String(employeePrice).trim() === "") {
    return Math.round((retailCents * (100 - EMPLOYEE_PERCENT_OFF)) / 100);
  }
  return dollarsToCents(employeePrice);
}

export function resolveEmployeeUnitPrice(
  retail: string | number | null | undefined,
  employeePrice: string | number | null | undefined,
  isCurrentEmployee: boolean,
): number {
  return Number(centsToDollars(resolveEmployeeUnitPriceCents(retail, employeePrice, isCurrentEmployee)));
}

export function formatEmployeeUnitPrice(
  retail: string | number | null | undefined,
  employeePrice: string | number | null | undefined,
  isCurrentEmployee: boolean,
): string {
  return centsToDollars(resolveEmployeeUnitPriceCents(retail, employeePrice, isCurrentEmployee));
}
