// Assistant knowledge source registry (ADI layer; customer-facing assistant is Zappy).
//
// Every business fact ADI may state lives here with its authoritative source,
// owner, verification date and status. Only `verified` entries are given to
// the model as facts; every other entry is rendered as an explicit
// "do not claim" rule so ADI cannot present an unverified policy as active.
//
// To change what ADI says about a policy: change the code/config it is sourced
// from, re-verify, and update the entry here (status + verifiedOn).

export type KnowledgeStatus = "verified" | "unverified" | "not_implemented" | "conflict";

export type KnowledgeEntry = {
  id: string;
  topic: string;
  status: KnowledgeStatus;
  /** What ADI may say (verified) or the gap it must not paper over (others). */
  statement: string;
  /** Where ADI should send the user when it cannot answer from verified facts. */
  referral?: string;
  source: string;
  owner: string;
  verifiedOn: string;
  verifiedBy: string;
  notes?: string;
};

export type CashDiscountSettings = {
  enabled: boolean;
  type: string | null;
  value: number | string | null;
};

const OWNER = "Luke (business owner)";
const VERIFIED_ON = "2026-11-20";
const BY_CODE = "code inspection";

export function formatCashDiscount(s: CashDiscountSettings | null | undefined): string {
  const value = Number(s?.value ?? 0);
  if (!s?.enabled || !Number.isFinite(value) || value <= 0) {
    return "No cash discount is currently configured for this store. Do not promise cash savings.";
  }
  const amount = s.type === "fixed" ? `$${value.toFixed(2)} off the order` : `${Number(value.toFixed(2))}% off merchandise`;
  return `Paying with cash at checkout currently gets ${amount} (applied automatically when the cash tender is selected).`;
}

export function buildKnowledgeRegistry(opts: { cashDiscount?: CashDiscountSettings | null } = {}): KnowledgeEntry[] {
  return [
    {
      id: "members_only",
      topic: "Membership and access",
      status: "verified",
      statement: "This store is members-only. Customers must be signed in with an approved member account to browse, chat with Zappy, or place orders. There is no guest or anonymous checkout. Orders a CSR places on a member's behalf belong to that member's account.",
      source: "artifacts/api-server/src/lib/auth.ts (requireAuth/requireApproved), routes/orders.ts, routes/ai.ts",
      owner: OWNER, verifiedOn: VERIFIED_ON, verifiedBy: BY_CODE,
      notes: "Production enforcement still to be confirmed in STAGING.",
    },
    {
      id: "fulfillment_options",
      topic: "Pickup and delivery",
      status: "verified",
      statement: "Pickup is always available at the store's active pickup locations. Delivery is only offered when the specialist on shift has enabled it: either personal delivery by the specialist or Uber Direct delivery. Uber Direct delivery shows a quoted delivery fee and ETA at checkout before you pay. If delivery isn't enabled for the current shift, only pickup is available.",
      source: "artifacts/api-server/src/lib/shiftDeliveryMode.ts (resolveCustomerFulfillment), routes/orders.ts (checkout quote)",
      owner: OWNER, verifiedOn: VERIFIED_ON, verifiedBy: BY_CODE,
    },
    {
      id: "cash_discount",
      topic: "Cash payment savings",
      status: "verified",
      statement: formatCashDiscount(opts.cashDiscount),
      source: "admin_settings.cash_discount_* (per tenant), lib/orderFinancialSnapshots.ts",
      owner: OWNER, verifiedOn: VERIFIED_ON, verifiedBy: BY_CODE,
      notes: "Live value read from this tenant's settings on every request.",
    },
    {
      id: "checkout_total",
      topic: "What you pay / PayPal",
      status: "verified",
      statement: "This store does not add a PayPal fee or card surcharge. The checkout total is merchandise plus tax, plus any delivery fee and optional tip, and it is shown before you pay. Any savings for paying cash come only from the cash discount described above.",
      source: "artifacts/api-server/src/routes/orders.ts (checkout quote: merchandise + tax + delivery + tip), payments/service.ts",
      owner: OWNER, verifiedOn: VERIFIED_ON, verifiedBy: BY_CODE,
      notes: "Intended PayPal convenience fee is NOT implemented. California Civ. Code 1748.1 allows cash discounts offered to all buyers; SB 478 restricts add-on fees not included in the advertised price. Get legal review before adding any PayPal fee.",
    },
    {
      id: "customer_credit",
      topic: "Customer credit",
      status: "verified",
      statement: "Customer Credit is a prepaid store balance. You can apply some or all of your available credit at checkout; it can't exceed your available balance or the order total. The app shows your available credit at checkout and on receipts.",
      referral: "the checkout screen or a store specialist for your current balance",
      source: "artifacts/api-server/src/payments/customerCredit.ts, routes/credits.ts, routes/orders.ts",
      owner: OWNER, verifiedOn: VERIFIED_ON, verifiedBy: BY_CODE,
      notes: "CONFLICT with intended policy: code never allows a negative balance, so 'negative balance = amount owed, settle before new orders' is not implemented. Owner decision needed.",
    },
    {
      id: "customer_credit_negative",
      topic: "Negative balances / amounts owed",
      status: "conflict",
      statement: "Negative credit balances, amounts owed, or a requirement to settle a balance before ordering",
      referral: "a store specialist",
      source: "Intended policy (owner) vs payments/customerCredit.ts (balance cannot drop below reserved)",
      owner: OWNER, verifiedOn: VERIFIED_ON, verifiedBy: BY_CODE,
    },
    {
      id: "live_account_data",
      topic: "Your orders and credit",
      status: "verified",
      statement: "You can look up the signed-in customer's own recent orders, the live status of one of their orders, and their available Customer Credit with the get_my_* tools. Report only what the tools return.",
      source: "lib/zappyOrderTools.ts (read-only, tenant + customer scoped), lib/zappyChatLoop.ts",
      owner: OWNER, verifiedOn: VERIFIED_ON, verifiedBy: BY_CODE,
    },
    {
      id: "other_accounts",
      topic: "Other people's accounts",
      status: "not_implemented",
      statement: "Any other customer's orders, balances or details",
      referral: "a store specialist",
      source: "By design: tools only ever read the signed-in customer's own records",
      owner: OWNER, verifiedOn: VERIFIED_ON, verifiedBy: BY_CODE,
    },
    {
      id: "lucifer_cruz_shipping",
      topic: "Lucifer Cruz shipping and tracking numbers",
      status: "unverified",
      statement: "Shipping carriers, shipping rates, or carrier tracking numbers for Lucifer Cruz orders",
      referral: "Lucifer Cruz customer support",
      source: "Not found in MyOrder.fun code: no carrier shipping or tracking-number integration (only pickup, CSR delivery and Uber Direct)",
      owner: OWNER, verifiedOn: VERIFIED_ON, verifiedBy: BY_CODE,
      notes: "Likely lives in the separate Lucifer Cruz web shop; verify there before enabling.",
    },
    {
      id: "staff_procedures",
      topic: "CSR shift, cash drawer and fulfillment procedures",
      status: "unverified",
      statement: "Staff procedures such as shift close-out, cash reconciliation or fulfillment workflows",
      referral: "your manager or the staff training materials",
      source: "docs/csr-delivery-closeout-accounting.md exists but is not yet approved as an ADI source; ADI is not told the user's role",
      owner: OWNER, verifiedOn: VERIFIED_ON, verifiedBy: BY_CODE,
    },
  ];
}

export function renderKnowledgeForPrompt(entries: KnowledgeEntry[]): string {
  const facts = entries.filter(e => e.status === "verified");
  const gaps = entries.filter(e => e.status !== "verified");
  const lines = [
    "VERIFIED STORE FACTS (you may state these; do not add to them):",
    ...facts.map(e => `- ${e.topic}: ${e.statement}`),
    "",
    "NOT AVAILABLE — never state, guess, or imply any of the following. Say you can't confirm it here and point the customer to the place listed:",
    ...gaps.map(e => `- ${e.statement} → ${e.referral ?? "a store specialist"}`),
  ];
  return lines.join("\n");
}
