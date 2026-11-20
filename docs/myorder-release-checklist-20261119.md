# MyOrder release checklist — 2026-11-19

Production status for every item below is **not deployed**.  This document is
the release ledger: a feature cannot move to production until its PR, tests,
isolated staging evidence, immutable images, guarded preflight, backup/restore,
and rollback target are recorded here.

| Workstream | Branch / PR | Current implementation and verification | Staging / production gate |
| --- | --- | --- | --- |
| Customer Orders and CSR Orders | `feat/orders-shift-tracking-20261119`, commit `5220cb0` | Exact paid-order redirect; separate CSR `/staff/orders`; compact 1/2/3-column cards; direct authorized actions; unpaid digital orders excluded from queue. Focused platform tests: 6 passed; API static tests: 49 passed. | Needs PR review and isolated staging customer/CSR payment recovery tests. |
| Queue visibility | PR #258 merged (`d4e06b1`) | Customers never receive operational banner; live tenant CSR shift suppresses banner. Focused helper/API static tests passed; PostgreSQL integration was previously skipped without disposable DB configuration. | Re-verify in combined staging. |
| Shift, cash drawer, commission | Existing `staff.tsx` / shifts implementation; dedicated PR not yet opened | Existing shift, bank, closeout and receipt logic must be reconciled before extraction into `/shift`; no standalone commission report allowed. | Needs implementation tests and staging drawer mock/physical safety test. |
| Receipt layout, logos, sticker, reprint | PR #260 (`fix/receipts-printing-20261119`, `ecebf3b`); print release tooling branch `release-tooling/print-ops-rollback-safety` | Reprint defect fixed: authenticated POST trigger, tenant/order-scoped receipt job only. Focused platform and API tests passed. Receipt/logo/sticker behavior requires print rendering checks. | Needs PR review, visual preview, queued-job inspection and isolated printer rehearsal; no drawer pulse from reprint. |
| PayPal and payment methods | `feat/payment-provenance-reports-20261119` (commit pending normal hook) | Future source preservation and `Unspecified digital` historical report labeling implemented; 23 focused provider/report tests passed. | Commit/PR, then sandbox-test every eligible method and duplicate capture/webhook behavior. |
| Speed Order top nine | `feat/speed-order-top-nine-20261119` | Existing branch must be reconciled with current catalogue/options and role policy before implementation. | Needs PR, authorization test and isolated staging UI test. |
| Inventory and product editing | `fix/inventory-table-controls-20261119` | Existing newer inventory worktree is preserved; location counts, variants and audited movements remain required. Item 1692 and checkout-field audit remain open. | Needs PR, tenant/inventory-movement tests and staging data audit. |
| Reports and exports | PR #259 merged for scope/CSV safety; `feat/reports-comparisons-20261119` for next work | Tenant scope and formula-safe CSV are merged. Full financial, channel, source, inventory/COGS/GL, tax and comparison reports remain open. | Requires complete-totals evidence, funding-source evidence, no silent limits, and staging export review. |
| Lucifer Cruz web/app branding | PR #257 merged foundation; receipt workstream pending | Tenant branding foundation exists. Exact `LC-Order_Icon-iOS-Default-1024@1x.png`, `fav.png`, attribution, and receipt assets must be located and verified before release. | Needs asset hashes, browser/PWA checks and staging screenshot evidence. |
| Zappy/ADI/SMS/onboarding | Separate feature PRs required | Keep Contractor Hub onboarding outside this release. ADI naming, customer-to-CSR chat, SMS sender configuration and onboarding persistence require separate review. | SMS sender change requires administrator configuration verification; do not expose credentials. |

## Release gates

1. Each cohesive branch has a reviewable PR with focused tests.
2. Isolated staging uses disposable test data and disabled real SMS, email, delivery, printing and drawer side effects unless a specific safe rehearsal enables a mock.
3. Build immutable API, Platform and Migrator images from the exact reviewed release commit; record manifest/config digests, architecture and revision labels.
4. Record fresh production backup, isolated restore rehearsal and verified current rollback images.
5. Run the guarded release preflight. Production migration remains disallowed unless separately authorized and exact applied lineage is verified.
6. Obtain explicit production authorization for the exact commit, image identities and plan.
