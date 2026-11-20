# Speed Order Gate 1 progress

Base: `28b987bb92960e0a496b99060acef06ae1446152` / `40e494b4cf474b93674c95956bbfe9274b2f9966`.

## Current increment: A — guest identity and capability foundation

- Draft migration `0084_guest_order_identity` is uncommitted. It adds guest identities, guest checkout sessions, token hashes, expiry/revocation/consumption state, ownership XOR, and tenant composite foreign keys. It was applied only to the named disposable test database; production schema presence check confirmed it is absent there.
- Token utility and focused tests are implemented. `guestTokens.test.ts`: 3/3 passed.
- Caller-owned transactional repository is implemented with a conditional `UPDATE … RETURNING`; PostgreSQL concurrency proof is still required.
- The isolated `myorder-archived-inventory-test-20261120` container was verified as loopback-only/default-bridge and uses database `myorder_p0_owner_approval_archived_visibility`, not staging or production. It lacked the Drizzle ledger but had the required orders/users/tenants tables; draft 0084 was applied there for disposable schema testing only.
- Background API typecheck began 2026-11-20. Its exit file is pending at `/tmp/myorder-speed-order-checks/api-typecheck.exit`; do not count it as passing until the file exists and is `0`.

## Remaining increments

1. Add isolated PostgreSQL migration/concurrency tests and verify repository rollback/idempotency behavior; then commit increment A.
2. Staff session endpoint and active-shift authorization.
3. Guest order creation/cash and compatibility repairs.
4. Guest PayPal and read-only tracking.
5. Speed Order UI and full Gate 1 regression/PR.

## Safety

No production/staging modification, database migration, payment, or deployment is authorized in this worktree.
