# Speed Order Gate 1 progress

Base: `28b987bb92960e0a496b99060acef06ae1446152` / `40e494b4cf474b93674c95956bbfe9274b2f9966`.

## Completed increment: A — guest identity and capability foundation

- `8495c1860afa467554f3c333146e51ae183086e8` scopes the guest-checkout router's strict staff-provenance middleware to `/guest-checkout/*`; it no longer intercepts customer `/cart/*` or `/orders` requests before `requireCustomerCheckoutAccess` runs.
- Migration `0084_guest_order_identity` remains draft and has been applied only to disposable local databases. It adds guest identities, guest checkout sessions, token hashes, expiry/revocation/consumption state, ownership XOR, and tenant composite foreign keys. It has not run in staging or production.
- Token utility, caller-owned conditional `UPDATE … RETURNING` repository, and staff session creation endpoint are implemented. The capability is returned only to the winning authorized creation request; idempotent replay returns metadata without plaintext capability.
- PostgreSQL integration evidence: `customer-checkout-route-postgres.integration.test.ts` passed **15/15** against a newly created loopback-only disposable PostgreSQL 16 container/database. It verifies legacy customer checkout compatibility, tenant isolation, unauthenticated denial, and that a staff-only catalogue operation remains behind full provenance.
- API typecheck, Platform production build, and `scripts/audit-secrets.sh` each exited **0** after the repair. The normal pre-commit lint-ratchet hook passed for `8495c18`.

## Remaining increments

1. Implement guest order creation and cash settlement by reusing the existing server-authoritative conversion, inventory reservation, cash-ledger, shift attribution, and closeout paths; add PostgreSQL tests for duplicate submission and stock races.
2. Implement read-only guest tracking and guest PayPal only after guest order creation is transactionally verified.
3. Build the tenant-scoped 3x3 Speed Order UI against the verified guest cash API; keep PayPal and delivery unavailable until their backend paths are complete.
4. Complete Gate 1 regression, migration-clone validation, and PR review evidence.

## Safety

No production/staging modification, database migration, payment, or deployment is authorized in this worktree.
