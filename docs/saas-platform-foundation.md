# MyOrder.fun SaaS foundation

## Branding occurrence inventory

The inventory command is `rg -i -l 'alavont|lucifer cruz|private and discreet|standard terms' artifacts lib deploy docs package.json`. At the Phase 1 baseline it reports 102 files. Each occurrence belongs to one of these explicit dispositions:

| Class | Representative locations | Disposition |
|---|---|---|
| Customer shell, metadata, auth, loading, navigation | `artifacts/platform/index.html`, `src/App.tsx`, `src/components/layout.tsx`, public manifest/assets | Default to MyOrder.fun; resolve tenant branding after authentication. |
| Customer catalogue, checkout, assistant, notices | `pages/catalog.tsx`, `pages/new-order.tsx`, `pages/dashboard.tsx`, `pages/ai-concierge.tsx`, `components/CatalogNotice.tsx` | Use tenant display branding and configured supplier fields. Missing disclaimer/attribution renders nothing. |
| Legal/static customer pages | `pages/terms.tsx`, `pages/privacy.tsx`, `pages/home.tsx`, `pages/waitlist.tsx`, `pages/pending.tsx` | Attribute the platform to MyOrder.fun; tenant-specific terms remain configuration data. |
| Receipts and customer messages | `api-server/src/lib/print`, `receiptRenderer.ts`, notification hooks and AI defaults | MyOrder.fun is the fallback. Tenant/supplier values must be passed as order-time display data; completed snapshots are immutable. |
| Active admin labels tied to legacy import columns | catalogue/import/inventory/settings administration pages | Preserve column/API compatibility names until the catalogue-normalization phase; relabel customer-visible controls separately. |
| Runtime compatibility identifiers | `alavontName`, `alavontCategory`, `luciferCruzName`, catalogue modes, session-storage keys | Preserve until a versioned compatibility migration exists. These are not presentation defaults. |
| Historical data and proof fixtures | SQL migrations, snapshots, audit tests, checkout-conversion proof, completed-order fixtures | Never rewrite for branding. |
| Deployment and operator documentation | `deploy/`, historical reports in `docs/` | Update only when operational meaning changes; retain historical provenance. |
| Static legacy artwork | existing `alavont-*` and `lc-*` assets | Stop referencing from defaults now. Delete only after a separate reference and retention audit. |

The three prohibited sentences are absent from rendered catalogue source. Regression tests cover the main customer shell and require configured disclaimers to be non-empty before a wrapper renders.

## Current architecture findings

- `global_admin` is the canonical platform role. `manager` and `tenant_admin` normalize to tenant `admin`; server permission code rejects every `platform.*` permission for non-global roles.
- Users carry a nullable `tenant_id`. Most order, payment, inventory, credit, and settings paths are tenant-keyed, although targeted legacy routes still require isolation audits.
- `tenant_settings` already provides authenticated tenant scope, optimistic versioning, validation, audit logging, and safe business metadata.
- `tenants.settings` is an existing JSON envelope. Phase 1 adds a typed `branding` subdocument without touching the concurrently edited migration ledger.
- The current frontend brand selector is a catalogue-view mode. It is not tenant resolution and previously hardcoded two companies.
- There is no SaaS plan-version, subscription, entitlement snapshot, usage-meter, SaaS invoice, or SaaS webhook ledger model. Storefront PayPal payments are order payments and must stay separate.
- Existing global-admin pages are foundations, not a complete SaaS control plane. Some summaries still perform broad queries and require explicit tenant filtering before aggregate analytics work.

## Branding model and forward migration sequence

Phase 1 envelope:

```text
tenants.settings.branding
  customer: display/legal names, logo/favicon, colors, contacts, website,
            checkout descriptor, terms, privacy notice, custom domain + state
  supplier: display name, logo, attribution, disclaimer, show-attribution flag
platform: owner-controlled MyOrder.fun defaults in a single server/client contract
```

Tenant administrators may edit safe display fields under `settings.edit_business`. Domain verification state is server-owned and is not accepted from the tenant patch schema. Every mutation is tenant-derived from the authenticated database user and audited.

Forward-only normalization, after migrations 0047/0048 are committed:

1. `0049_branding_profiles`: `platform_branding`, `tenant_branding`, `tenant_supplier_branding`, and `tenant_domains`; copy the typed JSON envelope without deleting it.
2. `0050_plan_feature_catalogue`: immutable plan versions, features, plan features, optional add-ons, and explicit legacy/default plan assignment.
3. `0051_tenant_subscriptions`: subscriptions, items, trials, periods, grace/suspension state, entitlement snapshots, and audited complimentary assignments.
4. `0052_usage_metering`: idempotent usage records, counters, limits, and billing-period rollups.
5. `0053_saas_billing`: provider-neutral customers, mandates, invoices, payments, credits, refunds, and provider event ledger, separate from storefront payment tables.
6. `0054_support_retention`: time-limited support grants, retention policies/jobs, exports, deletion requests, security events, and audit extensions.

Every migration is additive first, backfills deterministically, validates tenant ownership, and only removes compatibility reads in a later release. Orders, payment records, audit rows, imports, and completed-order branding snapshots are never rewritten.

## Console route/page map

Global-admin-only UI/API:

- `/global-admin/tenants` ↔ `/api/platform/tenants`: lifecycle, ownership, administrators, branding, domains.
- `/global-admin/plans` ↔ `/api/platform/plans`, `/features`: versioned catalogue and assignments.
- `/global-admin/subscriptions` ↔ `/api/platform/subscriptions`: paid and audited complimentary subscriptions.
- `/global-admin/billing` ↔ `/api/platform/billing`: invoices, payments, credits, refunds, delinquency.
- `/global-admin/usage` and `/analytics` ↔ aggregate tenant-safe usage, MRR/ARR, churn, GMV, adoption, and health.
- `/global-admin/security`, `/support`, `/retention`, `/audit`, `/status`: safe events, time-boxed impersonation, workflows, and environment-safe status.

Tenant billing-admin UI/API:

- `/admin/subscription` ↔ `/api/tenant/subscription`: current plan, renewal/cancellation, license state.
- `/admin/subscription/features` and `/usage`: available features, add/remove previews, limits.
- `/admin/subscription/billing`: billing contacts and authorized payment method handoff.
- `/admin/subscription/invoices/:id`: tenant-owned invoices and receipts.
- `/admin/service`: safe status, integrations, domains, and support; never host, shell, Docker, database, or secret access.

## Entitlement model

An entitlement decision is server-side and requires all of: authenticated canonical user; matching tenant ownership; role permission; active/trial/grace subscription state; enabled feature in the immutable entitlement snapshot; and remaining quantity/usage limit. Global admin bypass is explicit and audited, never inferred from browser metadata. Suspended tenants retain only authentication, billing recovery, export/retention rights defined by policy, and support contact. The migration assigns every existing tenant an explicit versioned `legacy` plan before enforcement activates.

## PayPal SaaS billing plan

- Keep SaaS billing modules and tables separate from storefront orders, PayPal order captures, Customer Credit, and refunds.
- Store server-authoritative plan version and price IDs; expose only signed change previews.
- Use PayPal Sandbox products/plans or invoicing capabilities only after a capability spike confirms proration/effective-date behavior.
- Create subscriptions server-side, require PayPal approval, and activate only after verified authoritative webhook/reconciliation state.
- Verify webhook signatures against the configured SaaS webhook ID; insert provider event IDs into a unique ledger before processing.
- Make activation, renewal, upgrade, downgrade, cancellation, refund, delinquency, and reconciliation handlers transactional and idempotent.
- Never treat a browser redirect as payment confirmation. Reconcile ambiguous or missing events from PayPal APIs and record the evidence.

## Assumptions and release blockers

- The root `MyOrder-Logo.png` is an authoritative working source, not committed. Its verified SHA-256 is `230e96e4128d38e06e56d2656907322b8e0a2dfd4a82ac1d7fea7c4803fb8f1b`.
- The source has alpha but its nontransparent bounds touch the 1080×1080 canvas, so deterministic derivatives remove no pixels; resizing uses contain semantics and preserves the full artwork.
- Existing tenant names are safe display fallbacks; unbranded/missing tenants fall back to MyOrder.fun.
- Domain DNS challenge issuance, certificate automation, object storage for uploaded logos, and global branding policy controls need explicit infrastructure design before activation.
- The dirty `_journal.json` already contains unrelated 0047/0048 work. Phase 1 deliberately avoids modifying or staging it; normalized tables wait for that ledger work to land.
- Live PayPal SaaS billing, production deployment, data migration, printing, PM2, CUPS, and printer queues are out of scope and remain blocked.
