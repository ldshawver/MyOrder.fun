# ADI knowledge source registry — MyOrder.fun

Source of truth: `artifacts/api-server/src/lib/adiKnowledge.ts`. Only **verified**
entries reach ADI as facts. Everything else is sent as an explicit "never state
this; refer the customer to …" rule. Verified 2026-11-20 by code inspection; owner: Luke.

| Policy | Status | What ADI says | Authoritative source | Gap / owner action |
|---|---|---|---|---|
| Members-only access | ✅ Verified (code) | Approved members only; no guest checkout; CSR orders belong to the member | `lib/auth.ts`, `routes/orders.ts`, `routes/ai.ts` | Confirm in STAGING |
| Pickup / delivery | ✅ Verified | Pickup always; delivery only when the shift enables personal or Uber Direct delivery; Uber fee + ETA quoted at checkout | `lib/shiftDeliveryMode.ts`, `routes/orders.ts` | — |
| Cash savings | ✅ Verified (live) | Reads this tenant's `cash_discount_*` settings per request; says "no cash discount" when disabled | `admin_settings`, `lib/orderFinancialSnapshots.ts` | Set the discount in Admin › Settings |
| PayPal fee | ✅ Verified: **none charged** | No PayPal fee or surcharge; total = merchandise + tax + delivery + tip | `routes/orders.ts` checkout quote | Intended PayPal fee **not implemented**. In California a separate card/PayPal surcharge is restricted (SB 478; Civ. Code 1748.1 allows cash discounts). Legal review before adding one |
| Customer credit | ✅ Verified | Prepaid store balance; apply up to available balance at checkout | `payments/customerCredit.ts` | — |
| Negative balance = owed | ⚠️ Conflict | Not stated | Code forbids negative balances | Owner decision: keep prepaid-only, or build receivables |
| Live balance / order status / history | ⛔ Not implemented | "I can't see that here — check the Orders page" | No ADI tools yet | Next increment: read-only member-scoped tools |
| Lucifer Cruz shipping / tracking numbers | ❓ Unverified | Refers to Lucifer Cruz support | No carrier integration in MyOrder | Verify in the Lucifer Cruz shop |
| CSR shift / cash drawer procedures | ❓ Unverified | Refers staff to manager | `docs/csr-delivery-closeout-accounting.md` not approved; ADI not role-aware | Approve doc + pass role |

To promote an entry: verify against code/config, update `status` and `verifiedOn` in `adiKnowledge.ts`, and add a test.
