# Release convergence record

## Source identity and release guard

The accepted webhook candidate is the immutable release base:

- Base commit: `8744d8e34ab8627555919aec337abde0c3291e0f`
- Base tree: `86c004b66acf42c5394fbfddde807e1882edafba`

The successor release commit and tree are supplied as full SHA inputs to the
protected workflow. The workflow requires the dispatch ref to equal the
requested commit, checks its tree, and checks that the commit descends from the
accepted base. The package carries that SHA/tree/base tuple; the production
controller checks the tuple against the workflow arguments and archive
checksum. API, platform, and migrator image tags must use that same full SHA.
The rollback source remains `c549816b2ce647c38fdf4a7c4d7d5e5b0036a8a6`
(`eb3bb038ca02ef94312c08ab8a8899f958ab51f7`).

Staging guard source must be a clean Git worktree registered directly beneath
the approved worktrees root, descended from the accepted base. It validates
`DEPLOY_SHA`, `DEPLOY_TREE`, image tags, Compose project, DB name and host,
PostgreSQL volume, network and proxy port. The staging env file is selected
through `MYORDER_STAGING_ENV_FILE` and must be protected mode `0600`; its path
and values are not committed. Existing staging containers must still resolve
to the `myorder-staging` project and staging Compose source.

## Recognized migration state and forward plan

The validator has 51 executable journal entries. It recognizes the staging
database's 49 ledger rows as the documented historical staging lineage: the
historical inventory/catalogue hashes are explicitly mapped to canonical
0069–0071, and the remaining applied rows include 0075 and 0076. The current
staging database therefore needs no Drizzle migration replay. Before any
staging mutation, the guard reruns the read-only validator and requires all
recognized lineage checks through 0076 plus the physical 0075/0076 schema
checks.

The production database has the recognized 42-row prefix through 0067. Its
candidate forward sequence is exactly the following nine canonical migrations
in order; the ordinary migrator validates the prefix before applying them:

| Migration | SHA-256 |
| --- | --- |
| 0068_print_jobs_document_job_types | `aef6cd781e24fc287130cd8bbcf84ceb3a699f4e034d7fd2862f27ceb61c0f79` |
| 0069_inventory_tenant_quantity_foundation | `d13d616485eec5df2c94c70dadb3d900c00979d363f27005051e05855327e51b` |
| 0070_catalogue_products_options_reorder | `a9c0bdef477fc724e91ee1f004936580b383f657cb71084eec6f0b42c6634702` |
| 0071_refund_state_constraint_reconciliation | `5988b2eac94914ac9e1f64c4fa0bcb2b75e43d4212a7a12db65e55d2636f1dcb` |
| 0072_order_created_notifications | `fa05e9d1bf5a7a7997b547c4e2ea329e3b5ef42e419a33e8c996d0072bf07bea` |
| 0073_admin_settings_tenant_uniqueness | `bd63d55eb56300beba49b464fdd194e4b6429e3015cf02aa87e92c5d85f9a870` |
| 0074_tenant_slug_case_insensitive_unique | `11d51844af57a849384272368bef2ec131547c090915b8cddd2904f1ea8dccde` |
| 0075_catalogue_variant_attributes | `b6491e32ca4e8ae65dfbaab5e33398465fdd747a23765726253852b8f2fc509a` |
| 0076_tenant_woo_store_url_no_default | `99b25cd808d54c1f5d6d957701b64561bd948a3cb4c06aab0000b047ede66e73` |

Production must finish with 51 validated ledger rows and the physical effects
of 0075 and 0076. The release controller also verifies the P0 marker,
provenance columns, and provenance index before stopping writers and again
after migrations. It takes and verifies a backup and isolated restore rehearsal
before running the forward sequence. This document describes a future guarded
release; it does not authorize execution.

## P0 marker and provenance discrepancy

Migrations 0075 and 0076 do not create the P0 owner-approval marker or the
`users.approved_at`, `users.approved_by_clerk_id`, and
`users_owner_approval_provenance_idx` objects. Those are provided only by the
separate approved SQL patch `deploy/hotfix-owner-approval.sql`, whose reviewed
SHA-256 is
`cd496d318643c3f485a563445ae5d3f59b3f4ea79d991108b2e7c17dd83db54a`. That
patch uses `IF NOT EXISTS` and `ON CONFLICT DO NOTHING`, is transactional, and
does not write Drizzle ledger rows. These clauses make a second application
non-duplicating on the expected schema, but they do not repair a pre-existing
object with the wrong definition; therefore the pre-patch absence checks and
post-patch structural verification remain mandatory.

The staging database received canonical 0075/0076 migration effects but did
not receive the separate P0 patch. This is a sequencing gap between the
Drizzle migration release and the P0 compatibility runbook, not evidence that
0075/0076 create P0 objects. Staging forward plan: verify the existing 49-row
recognized lineage and 0075/0076 effects; apply the checksum-verified P0 SQL
through the separately approved staging procedure; verify the one marker, two
columns, valid index, and unchanged 49-row ledger; then deploy the exact
candidate images after all configuration and isolation gates pass.

## Required staging-only configuration

The staging Clerk owner value must be the designated owner's immutable user
subject from the dedicated staging Clerk application, verified through that
application's authenticated Backend API. Install it directly into the
protected staging environment file selected by `MYORDER_STAGING_ENV_FILE`;
never send it through chat, logs, tickets, or source control. The protected
file is mode `0600`; the owner setting is now present and format-checked.

The Clerk keys, session secret, encryption key, database URL, and Clerk webhook
secret are present in both environment files; only presence was checked. The
staging public Clerk proxy is configured to the staging host. Production uses
the Compose default `https://myorder.fun/api/__clerk`. There is no CORS
environment variable: the API code currently sets credentialed CORS with a
reflected request origin (`origin: true`). This is the implemented policy; no
additional CORS secret or value should be invented for this release.

The owner has decided WooCommerce external integration is production-only.
Staging must explicitly set `WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED=false`.
The staging Compose file does not pass a WooCommerce store origin to the API,
and the release guard does not require a Woo tenant. Server-side request
boundaries block test-connection, sync, health probes, webhook reconciliation,
and order dispatch even when tenant credentials remain stored. Do not remove
or rotate saved tenant credentials. Existing signed-webhook and PostgreSQL
tests validate the implementation offline; staging does not contact an
external WooCommerce store.

Before staging tests, disable receipt and label printing. Payment mode and
PayPal must remain sandbox, live payment stays false, email/SMS/push stay
disabled, Uber dispatch stays disabled, and order notification workers stay
off. Staging uses the explicit production-only WooCommerce policy; the API
blocks all external WooCommerce operations even if encrypted tenant credentials
remain stored. No external WooCommerce store is used during staging acceptance.

## Tax decision

Production checkout currently resolves the active Sacramento tax configuration
at 8.75% effective 2026-04-01. The legacy `admin_settings` value is 8.00% and
is not the checkout source. The active database row does not constitute tax
approval. The owner must explicitly select 8.75%, 8.00%, or another rate backed
by authoritative guidance before a narrowly scoped settings/display
consistency change is prepared. No tax configuration is changed here.

## Release gates

No backup, image, staging database change, or production change is performed by
this source-preparation task. Staging remains blocked until the guard identity,
owner setting, explicit production-only Woo policy, P0 patch, and full migration
validation are verified. Production requires a separate
owner tax decision, a verified backup/restore point, the nine-migration
preflight, owner/configuration checks, immutable images, and separate explicit
production authorization.
