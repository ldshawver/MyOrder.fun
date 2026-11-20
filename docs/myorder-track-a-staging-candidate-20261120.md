# MyOrder Track A staging source definition — 2026-11-20

This checkpoint freezes the merged main application source for an independent
staging release candidate. It does **not** claim that images were built or that
staging or production was changed.

## Frozen source

- Commit: `28b987bb92960e0a496b99060acef06ae1446152`
- Tree: `40e494b4cf474b93674c95956bbfe9274b2f9966`
- Migration tip: `0083_uber_quote_authoritative_settings.sql`
- Explicitly excluded: migration `0084`, guest checkout, and Speed Order 3x3

The machine-readable definition is
`deploy/staging-main-candidate-20261120.json`. Its image references remain null
and every release/deployment gate remains false. The accompanying test prevents
this source definition from being mistaken for a deployable candidate.

## Source versus observed production

The production health endpoint reported
`733d266eca5073df7ab73abe4e003b0b76215107` during the read-only audit on
2026-11-20. Source presence beyond that revision is not evidence of deployment.

| Area | Observed production / pinned ancestry | Frozen main source | Remaining gate |
| --- | --- | --- | --- |
| Website/favicon | Lucifer Cruz title, description, favicon and Apple icon served | Present | Browser cache/install checks |
| PWA identity | Manifest still says `MyOrder.fun` / `MyOrder` | Same static manifest; tenant-aware manifest support is newer source | Complete identity decision and install testing |
| Orders | Initial unified cards present in production ancestry | New customer/CSR separation and tracking present | Authenticated staging ownership/role smoke |
| Cash | Tender, change and reconciliation foundation present | New authorized queue-closeout repair present | Staging cash-session and idempotency tests |
| Customer tracking/navigation | Earlier tracking/navigation present | Newer route separation and direct actions present | Customer/CSR staging journey |
| PayPal v6 | v6 checkout and confirmation present in production ancestry | Funding-source preservation is newer source | Sandbox methods, duplicate capture and webhook replay |
| Tenant authorization | Earlier tenant controls present | Later tenant-boundary repairs and fixtures present | Two-tenant PostgreSQL and staging regression suite |

Focused source validation completed during the audit: three Platform files with
11 tests and three API files with 87 tests passed. This does not replace the
full CI suite or authenticated staging acceptance.

## Fail-closed promotion gates

Before this becomes a deployable staging candidate:

1. Review staging release tooling through migration `0083`; the existing
   feature controller is pinned to an older source and migration `0077`.
2. Build API, Platform and Migrator images from the exact frozen commit/tree.
3. Record registry manifest digest, image config digest, architecture and both
   revision labels for every image.
4. Run full CI, a disposable migration rehearsal through `0083`, and focused
   two-tenant authorization, Orders, cash and PayPal sandbox checks.
5. Obtain separate staging authorization. Production remains prohibited unless
   the exact images and plan receive explicit production authorization.
