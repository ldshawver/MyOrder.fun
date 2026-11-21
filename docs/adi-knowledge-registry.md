# Assistant knowledge source registry — MyOrder.fun (first tenant)

Naming: **Zappy** is the customer-facing assistant and the Zappy Software POS brand. **ADI** is the AI/knowledge layer behind it. MyOrder.fun is the first tenant, so assistant wording says "this store", not a tenant name.

Source of truth: `artifacts/api-server/src/lib/adiKnowledge.ts`. Only **verified**
entries reach Zappy as facts. Everything else is sent as an explicit "never state
this; refer the customer to …" rule. Verified 2026-11-20 by code inspection; owner: Luke.

| Policy | Status | What Zappy says | Authoritative source | Gap / owner action |
|---|---|---|---|---|
| Members-only access | ✅ Verified (code) | Approved members only; no guest checkout; CSR orders belong to the member | `lib/auth.ts`, `routes/orders.ts`, `routes/ai.ts` | Confirm in STAGING |
| Pickup / delivery | ✅ Verified | Pickup always; delivery only when the shift enables personal or Uber Direct delivery; Uber fee + ETA quoted at checkout | `lib/shiftDeliveryMode.ts`, `routes/orders.ts` | — |
| Cash savings | ✅ Verified (live) | Reads this tenant's `cash_discount_*` settings per request; says "no cash discount" when disabled | `admin_settings`, `lib/orderFinancialSnapshots.ts` | Set the discount in Admin › Settings |
| PayPal fee | ✅ Verified: **none charged** | No PayPal fee or surcharge; total = merchandise + tax + delivery + tip | `routes/orders.ts` checkout quote | Intended PayPal fee **not implemented**. In California a separate card/PayPal surcharge is restricted (SB 478; Civ. Code 1748.1 allows cash discounts). Legal review before adding one |
| Customer credit | ✅ Verified | Prepaid store balance; apply up to available balance at checkout | `payments/customerCredit.ts` | — |
| Negative balance = owed | ⚠️ Conflict | Not stated | Code forbids negative balances | Owner decision: keep prepaid-only, or build receivables |
| Own orders / status / credit | ✅ Verified (tools) | Looks up the signed-in member's own recent orders, one order's status, and available credit | `lib/zappyOrderTools.ts`, `lib/zappyChatLoop.ts` | Read-only; other customers always "not found" |
| Lucifer Cruz shipping / tracking numbers | ❓ Unverified | Refers to Lucifer Cruz support | No carrier integration in MyOrder | Verify in the Lucifer Cruz shop |
| CSR shift / cash drawer procedures | ❓ Unverified | Refers staff to manager | `docs/csr-delivery-closeout-accounting.md` not approved; ADI not role-aware | Approve doc + pass role |

To promote an entry: verify against code/config, update `status` and `verifiedOn` in `adiKnowledge.ts`, and add a test.
