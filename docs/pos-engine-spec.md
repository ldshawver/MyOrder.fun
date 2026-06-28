# POS ENGINE SPEC

## 1. CORE FLOW
Cart → POS Engine → Inventory Reserve → Order Creation → Shift Assignment → Payment → Finalization

---

## 2. ORDER STATE MACHINE

CREATED
RESERVED
PAYMENT_PENDING
PAID
ASSIGNED
PREPARING
READY
COMPLETED
CANCELLED

Rules:
- Only POS engine can change states
- Invalid transitions must throw errors

---

## 3. INVENTORY RULES

- Inventory is single source of truth
- Must reserve before order creation
- Must release on cancel/failure
- Must never go negative

---

## 4. SHIFT RULES

- Engine assigns shifts
- Only ACTIVE shifts allowed
- Shift queue is read-only display only

---

## 5. PAYMENT RULES

- Payment method is metadata only
- No payment logic in frontend
- No checkout outside engine

---

## 6. ENGINE GUARANTEE

Only valid flow:

validateCart()
→ reserveInventory()
→ createOrder()
→ assignShift()
→ finalize()

---

## 7. HARD RULES

- No frontend business logic
- No direct order creation outside engine
- No inventory bypass
- DB is source of truth
