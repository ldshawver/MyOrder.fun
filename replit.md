# Lucifer Cruz / OrderFlow Platform — MyOrder.fun

## Platform Ecosystem

MyOrder.fun is part of a three-platform connected ecosystem. Each platform is independent at the database, authorization, and security level.

| Platform | Domain | Purpose |
|---|---|---|
| **LUXit.app** | luxit.app | Master SaaS / CRM / onboarding / AI agents / analytics / workforce management / communications hub |
| **MyPayLink.app** | mypaylink.app | Workforce and payroll operations — employee onboarding, payroll processing, timeclock, scheduling, contractor management, ACH workflows |
| **MyOrder.fun** | myorder.fun | Secure commerce and ordering — catalog/menu management, WooCommerce sync, checkout, order notifications, dual-catalog support |

These systems may share authentication, analytics patterns, and support tooling, but **each platform has its own isolated database, tenant layer, and authorization system**.

---

## MyOrder.fun — Overview

OrderFlow is a production-ready, single-tenant adult boutique ordering platform for Lucifer Cruz. Built as a pnpm workspace monorepo with TypeScript throughout. Deployed to VPS at myorder.fun. Single shared environment — all approved users share one global catalog, orders, and settings.

**Company:** Alavont Therapeutics  
**Logo:** `artifacts/platform/public/alavont-logo.png`  
**Theme:** Deep navy (#0B1121) background, electric blue primary (#3B82F6), glass morphism card style

---

## Architecture Rules

These rules are mandatory and must not be changed without explicit sign-off.

### Database
- **Postgres is the production source of truth.** No exceptions.
- SQLite fallback is allowed only in local development (`NODE_ENV !== "production"`).
- SQLite must **never activate silently** in production. If `DATABASE_URL` is missing the server must throw and refuse to start.
- Current enforcement: `lib/db/src/index.ts` throws `Error("DATABASE_URL must be set...")` at import time if the env var is absent — this prevents the server from booting without a database.

### Integration Authority
| Integration | Role | NOT responsible for |
|---|---|---|
| **Postgres** | Source of truth for all operational data | Nothing — it is authoritative |
| **Stripe** | Financial authority — payments, invoices, refunds, order billing | Entitlements, access gating |
| **Twilio** | Communications layer — SMS order updates, notifications, verification | Payments, data storage |
| **Airtable** | Operational visibility — lightweight order ops, vendor coordination | Source of truth, billing, auth |
| **WooCommerce** | Product/catalog sync source | Checkout (handled by Stripe) |
| **RevenueCat** | Optional SaaS licensing / admin entitlements | Order payments, financial records |
| **GitHub** | Dev ops — issue tracking, deployment visibility, AI bug reports | Operational data |
| **OpenAI** | AI concierge — chat, upsell recommendations | Financial actions, autonomous orders |
| **Clerk** | Authentication and identity | Authorization (handled by RBAC in Postgres) |

### Security
- No secrets or API keys may be exposed client-side.
- All external integrations must fail gracefully — integration unavailability must never crash the core ordering flow.
- OWASP best practices apply to all checkout and customer-facing flows.
- Server-side validation is mandatory for all inputs (Zod).
- Rate limiting is enforced on all `/api` routes.
- AI agents must not autonomously process payments, move money, or bypass human approval for financial actions.

---

## Product Features

- **Dual-Brand Experience**: Lucifer Cruz branding (red #DC143C, silver, black) when logged out; Alavont Therapeutics (deep navy, electric blue) when logged in. Menu toggle on catalog page switches between Alavont catalog and Lucifer Cruz WooCommerce store (set `VITE_WOOCOMMERCE_URL` env var to activate).
- **Simplified Onboarding**: Access request form collects only name, email, phone, and optional message — no company name, business type, or volume fields.
- **Customer Home = Shop Experience**: Logged-in customers land on a combined Alavont logo + AI shopping assistant + featured product grid (thumbnails). Admin/staff still see the metrics dashboard.
- **Catalog with Thumbnails**: Product grid with image thumbnails, category filter pills, and brand toggle. `mapItem()` resolves `alavontImageUrl ?? imageUrl` so CSV-imported products display thumbnails correctly. Search covers `alavontName`, `luciferCruzName`, `labName`. Empty-state messages distinguish "truly empty", "items exist but LC filter hides them", and "search/category filter hiding items". Lucifer Cruz tab shows only items with `luciferCruzName` set. Smart empty-state messages tell admins exactly what's wrong.
- **Admin Catalog Debug** (`/admin/catalog-debug`): Full diagnostic page — summary stat cards, diagnostic callouts, category breakdown, per-row visibility badges and issue flags, and a WooCommerce sync panel with credential entry. Filters to show only hidden or missing-field rows.
- **AI Concierge** (`/ai-concierge`): Full-page "high-end electric therapeutic lounge" experience — animated floating ConciergeAvatar orb (Framer Motion, blink/float/pulse), FirstTimeWelcomeModal 4-step onboarding (localStorage key `hasSeenConciergeIntro_v2`), side panel with Quick Actions + AI-suggested product tiles, and electric chat bubbles. Signed-in users land here by default (HomeRedirect).
- **Customer Service Rep Shift Management**: Staff (Customer Service Reps, role: `business_sitter`) clock in with beginning inventory counts + starting cash bank amount. The system tracks cash vs card sales in real time via `orders.paymentMethod`. Active shift dashboard shows 4-stat bar: Orders / Revenue / Cash Bank (running) / Units Sold. Payment method badge on each order card. Clock-out opens a reconciliation form: rep enters physical ending counts for every inventory item and actual cash in box; system computes Expected End (start - sold) vs Actual End and flags discrepancies. End-of-shift summary shows full reconciliation grid (Start | Sold | Expected | Actual | Diff) and a cash bank reconciliation table (Starting Cash + Cash Sales = Expected vs Actual). Discrepancies highlighted in red with an admin notification banner. Nav label: "CSR Queue". Role label in admin users panel: "Cust. Service Rep". Schema: `lab_tech_shifts.cashBankStart`, `lab_tech_shifts.cashBankEnd`, `shift_inventory_items.quantityEndActual`, `shift_inventory_items.discrepancy`, `orders.paymentMethod`.
- **Clerk Webhook User Sync**: `POST /api/webhooks/clerk` handles `user.created`, `user.updated`, and `user.deleted` events from Clerk. New users are inserted with `status = 'pending'`; updates sync email/name/phone; deletes remove the record. Verified via svix signature. Requires `CLERK_WEBHOOK_SECRET` env var (set in Clerk Dashboard → Webhooks).
- **User Approval Gate**: Users table has a `status` column (`pending | approved | rejected`, default `pending`). New sign-ups land on `/pending` (a branded "awaiting approval" page) until an admin sets their status to `approved`. `admin` role bypasses the gate. `requireApproved` middleware in `auth.ts` can be added to individual API routes.
- **Hardened RBAC**: 4 roles — `admin`, `supervisor`, `business_sitter`, `user`
- **Single Tenant**: House tenant ID=1 "Lucifer Cruz". `getHouseTenantId()` in `lib/singleTenant.ts` caches this. All DB inserts requiring a NOT NULL tenantId FK use this. No per-user tenant assignment.
- **Customer Ordering UI**: Catalog browsing, cart, checkout, order tracking with animated hourglass while pending
- **Staff/Admin Dashboards**: Order queues, user management, catalog CRUD
- **Tokenized Payments**: Stripe PaymentIntent integration (sandbox-safe fallback without keys)
- **Order Status Notifications**: Persistent notification records per user + browser push notifications
- **MFA for Global Admin**: TOTP-based 2FA with backup codes
- **Full Audit Logging**: Every privileged action logged with actor, IP, resource
- **E2E Encryption Flag**: Client-side encrypted order notes (isEncrypted flag)
- **Mobile-First Responsive**: Bottom tab nav on mobile, sidebar on desktop, safe-area padding
- **Thermal Print Subsystem**: Auto-prints kitchen tickets and customer receipts on order creation via a self-hosted Ubuntu print bridge. Full admin UI for printer management, job history, retry/reprint controls, and auto-print toggle.
- **Feedback & Bug Reports**: Floating "Feedback" button on every authed page (`FloatingFeedbackButton.tsx`) opens a modal — type (bug/ux/feature/general), severity, title, description, optional 2MB screenshot. Auto-captures `pageUrl` + `userAgent`. Backend tables `feedback_tickets` + `feedback_ticket_comments`. Admin dashboard at `/admin/feedback` with filters (type/status/priority/owner/date), full status workflow (new → reviewed → priority_fix → in_progress → waiting_on_user → closed/rejected), Priority Fix flag, owner assignment, internal notes (hidden from submitter) + public replies. RBAC: regular users only see/comment on their own tickets; admin+supervisor see all and can PATCH. In-app notifications (`feedback_new`/`feedback_status`/`feedback_comment`) fan out to admins on submit and to the submitter on status/reply. Screenshots validated as `data:image/(png|jpeg|gif|webp);base64,…` server-side AND on render to block javascript: data-URI XSS.
- **Integration Health Endpoint** (`GET /api/integrations/health`): Admin-only endpoint returning config/connectivity status for every external integration (Stripe, Twilio, Airtable, GitHub, WooCommerce, RevenueCat, OpenAI). Reports `connected | missing_config | error` — no secrets or URLs in the response. Stripe does a lightweight live check; others report config presence.

---

## WooCommerce (Lucifer Cruz Menu)

Two separate env vars control WooCommerce:

- `VITE_WOOCOMMERCE_URL` — frontend build var. Activates the Lucifer Cruz menu tab with product links out to the WooCommerce store. Does **not** expose credentials.
- `WOOCOMMERCE_URL` + `WOOCOMMERCE_KEY` + `WOOCOMMERCE_SECRET` — server-side vars for future catalog sync API calls. Checked by the integration health endpoint.

---

## UI / UX

- **Branding**: Dark navy + electric blue with glass morphism cards (`glass-card`, `card-hover-glow` CSS classes)
- **Animated Hourglass**: Canvas-based component (`AnimatedHourglass.tsx`) shown to customers while orders are pending/processing — sand particles, ring pulses, glow effects, flip animation
- **Push Notifications**: `usePushNotifications` hook — staff notified when orders are placed; customers notified when orders are ready
- **Mobile Navigation**: Bottom tab bar (Dashboard, Catalog, Orders, Concierge) + slide-over menu for additional routes
- **Loading Screen**: Pulsing Alavont logo while app identity is loading

---

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Auth**: Clerk (via `@clerk/express` on server, `@clerk/react` on client)
- **Database**: PostgreSQL + Drizzle ORM (Drizzle Kit for migrations)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (for API server), Vite (for React frontend)
- **React**: React 18 + Vite + TanStack Query + Wouter + Tailwind CSS + shadcn/ui

---

## Security

- Rate limiting on all `/api` routes (15 min/300 req global, 1 min/10 req MFA, 1 hr/5 req onboarding)
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`
- RBAC middleware enforced in every route via `requireRole()`
- No tenant isolation — single tenant, all queries are global
- Audit log on all privileged actions
- TOTP MFA for `admin` (via `otplib`)
- `app.set("trust proxy", 1)` for rate-limiter behind Replit proxy

---

## Database Safety

| Environment | Database | Behavior if missing |
|---|---|---|
| Production | Postgres (required) | Hard throw at startup — server refuses to boot |
| Development | Postgres preferred; SQLite fallback only if explicitly configured | Warning logged |

**Enforcement:** `lib/db/src/index.ts` throws immediately if `DATABASE_URL` is absent. There is no silent SQLite fallback anywhere in the codebase. Any future SQLite usage must be gated behind an explicit `NODE_ENV !== "production"` check.

---

## Structure

```text
workspace/
├── artifacts/
│   ├── api-server/           # Express 5 API server (builds to dist/index.mjs)
│   └── platform/             # React + Vite frontend (served at /)
│       ├── public/
│       │   └── alavont-logo.png   # Company logo (also used as favicon)
│       └── src/
│           ├── components/
│           │   ├── layout.tsx               # Sidebar + mobile nav + FloatingFeedbackButton
│           │   └── AnimatedHourglass.tsx    # Canvas hourglass for pending orders
│           ├── hooks/
│           │   └── usePushNotifications.ts  # Browser push notification hook
│           └── pages/                       # All page components
├── lib/
│   ├── api-spec/             # OpenAPI 3.1 spec + Orval codegen config
│   ├── api-client-react/     # Generated React Query hooks (src/generated/)
│   ├── api-zod/              # Generated Zod schemas from OpenAPI
│   └── db/                   # Drizzle ORM schema + DB connection
│       ├── src/schema/       # All DB tables (tenants, users, catalog, orders, etc.)
│       └── seed.ts           # Sample data seed script
├── tsconfig.base.json        # Shared TS options
├── tsconfig.json             # Root project references
└── pnpm-workspace.yaml
```

---

## Database Schema

Tables: `tenants`, `users`, `onboarding_requests`, `catalog_items`, `orders`, `order_items`, `order_notes`, `audit_logs`, `notifications`, `feedback_tickets`, `feedback_ticket_comments`

**Important:** `users.email` is nullable. Partial unique index: `WHERE email IS NOT NULL AND email != ''`. Always store `null` (not `""`) for missing emails.

**Numeric fields:** `price`, `subtotal`, `total`, `tax`, `unitPrice`, `totalPrice` — always call `parseFloat()` when reading from DB.

---

## API Routes

All routes at `/api/*`. Key route groups:

- `GET /api/healthz` — public health check (status, sha, uptime)
- `GET /api/integrations/health` — admin-only integration status check
- `POST /api/onboarding/request` — public tenant signup request
- `GET /api/users/me`, `POST /api/users/sync` — current user profile
- `GET/POST /api/catalog` — catalog CRUD
- `GET/POST /api/orders` — order management
- `POST /api/ai/chat`, `POST /api/ai/upsell` — AI concierge
- `POST /api/payments/tokenize`, `POST /api/payments/:id/confirm` — payment flow
- `GET /api/admin/stats`, `POST /api/admin/mfa/setup`, `POST /api/admin/mfa/verify`
- `GET/PATCH /api/onboarding` — global admin onboarding review
- `GET /api/audit` — audit log access (global_admin only)
- `GET /api/notifications`, `PATCH /api/notifications/:id/read` — notifications per user
- `GET/POST /api/feedback`, `GET/PATCH /api/feedback/:id`, `GET/POST /api/feedback/:id/comments` — feedback module

---

## Auth Pattern

Server middleware chain: `requireAuth → loadDbUser → requireDbUser → requireRole(...)`

`getOrCreateDbUser` — selects by clerkId first; inserts if absent; on conflict falls back to select-by-clerkId then select-by-email (updates clerkId if found by email).

Clerk middleware applied globally; individual routes call `requireAuth` to enforce authentication.

---

## Environment Variables

### Required
- `DATABASE_URL` — PostgreSQL connection string (server refuses to start without this)
- `SESSION_SECRET` — session signing
- `CLERK_SECRET_KEY` — Clerk backend key
- `VITE_CLERK_PUBLISHABLE_KEY` — Clerk frontend key
- `VITE_CLERK_PROXY_URL` — Clerk proxy URL (auto-set)

### Optional — Integrations
| Variable | Integration | Effect if missing |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI | AI concierge falls back to stub responses |
| `STRIPE_SECRET_KEY` | Stripe | Payment flow uses sandbox sandbox mode |
| `STRIPE_PUBLISHABLE_KEY` | Stripe | Stripe Elements disabled |
| `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` | Twilio | SMS notifications silently skipped |
| `AIRTABLE_API_KEY` + `AIRTABLE_BASE_ID` | Airtable | Ops visibility sync disabled |
| `GITHUB_TOKEN` + `GITHUB_REPO` | GitHub | Bug report ticket creation disabled |
| `WOOCOMMERCE_URL` + `WOOCOMMERCE_KEY` + `WOOCOMMERCE_SECRET` | WooCommerce | Server-side catalog sync disabled |
| `VITE_WOOCOMMERCE_URL` | WooCommerce | Frontend LC menu tab shows "not connected" |
| `REVENUECAT_SECRET_KEY` | RevenueCat | Entitlement gating disabled |
| `CLERK_WEBHOOK_SECRET` | Clerk | Webhook user sync disabled |

All integration failures must be graceful — missing config must never crash the core ordering flow.

---

## Development Commands

```bash
# Push DB schema
pnpm --filter @workspace/db run push

# Seed sample data
cd lib/db && /path/to/tsx seed.ts

# Regenerate API client from OpenAPI spec
pnpm --filter @workspace/api-spec run codegen

# TypeScript check (builds project references)
pnpm run typecheck

# Run tests (api-server vitest suite)
pnpm test

# Build API server
pnpm --filter @workspace/api-server run build

# Lint all packages (fails on any warning — 0 warnings enforced)
pnpm lint

# Run lint warning ratchet (enforces per-package warning ceilings)
pnpm lint:ratchet

# Update the ratchet baseline after fixing warnings
pnpm lint:ratchet --update
```

---

## CI / GitHub Actions

| Workflow | File | Triggers | What it does |
|----------|------|----------|--------------|
| **CI** | `.github/workflows/ci.yml` | Every push (all branches), every PR | Installs deps → typecheck → lint (errors on any warning) → lint ratchet → tests |
| **Deploy** | `.github/workflows/deploy.yml` | Push to `main` only, plus manual dispatch | Runs the same full check job first (`needs: [test]`), then deploys to VPS |

**The deploy is blocked if tests or lint fail.**

### Lint Gate
- `artifacts/api-server/package.json` and `artifacts/platform/package.json` both run `eslint src --max-warnings 0`
- `.lint-threshold` stores per-package warning ceilings (`api-server: 0`, `platform: 0`, `mockup-sandbox: 1`)
- To update baseline: `pnpm lint:ratchet --update` then commit `.lint-threshold`

---

## TypeScript & Composite Projects

- Always typecheck from root with `pnpm run typecheck`
- `lib/api-client-react` must be built (`tsc`) before platform can typecheck
- Project references ensure correct cross-package resolution
- Zod schemas: `email: zod.string().nullable().optional()` — use `field ?? undefined` when passing to avoid null/undefined Zod rejections

---

## Operating Rules (Pre-Migration Stabilization)

### Source of Truth
- **GitHub** = code source of truth. Pull latest before making changes.
- **VPS production** = runtime source of truth. PostgreSQL data must be preserved.
- Replit is a build/test/deploy staging environment only — not a preview environment.

### DO NOT
- Require Clerk setup inside Replit or block work because Replit preview is blank
- Rebuild from scratch, reset the database, or create duplicate tables
- Redesign UI, change branding/layout, or switch frameworks (no Next.js, no framework swaps)
- Change the Plasmic integration method or move business logic into Plasmic
- Mix Alavont and Lucifer Cruz inventory/reporting
- Edit WooCommerce-managed Lucifer Cruz products inside MyOrder
- Hardcode VPS-specific paths or introduce Replit-specific dependencies

### Testing Approach
- Unit tests, API tests, typecheck, and build validation — not Replit preview
- Mock auth only in tests where needed; do not alter production auth flow for Replit convenience
- Provide exact VPS deploy commands after every approved fix

### Schema Change Rules (mandatory before any migration)
1. Explain current schema issue
2. Provide migration plan
3. Confirm no data loss + rollback plan
4. Get approval
5. Add proper Drizzle migration (idempotent, preserves existing data)
6. Never ask user to paste raw SQL unless emergency

### Completion Checklist (every fix)
- [ ] typecheck/build passes for affected package
- [ ] relevant tests pass
- [ ] no unrelated files changed
- [ ] exact deploy commands provided
- [ ] env/migration changes identified

### Priority Order (POS stabilization)
1. POS shift/queue workflow
2. CSR Sales Box selection
3. Starting/ending inventory
4. Inventory by box/location
5. Catalog visibility
6. Add-to-cart flow
7. Zappy AI product search/cart assist
8. Checkout mobile usability
9. Delivery tracking workflow
10. Reports/reprints
11. Admin permissions
12. Plasmic app-host ✅ done

### Private Server Migration Readiness (build toward)
- Documented Docker deployment, env vars, backup/restore, migrations, SSL/proxy
- No hardcoded VPS paths, no Replit-specific dependencies, no preview-only assumptions
- Target: self-hosted OptiPlex running Docker (Coolify/Traefik or Nginx TBD)

### Plasmic Rules
- Vite/React codegen only — no Next.js Plasmic loader
- `/plasmic-host` public + iframe-compatible; `/plasmic-test` for rendered component testing
- Plasmic controls UI shells, landing pages, cards, visual layouts only
- Cart, checkout, pricing, auth, inventory, reports, permissions stay in backend/app logic

---

## Integration Implementation Plan

The following integrations are planned but not yet implemented. Build in this order (each phase unblocks the next).

### Phase 1 — Twilio Order Notifications
**Effort:** Small. **Value:** Immediate operational improvement.

- Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` to env/secrets
- Create `artifacts/api-server/src/lib/twilio.ts` — thin wrapper with a `sendSms(to, body)` helper that no-ops gracefully when vars are absent
- Hook into order status changes (`PATCH /api/orders/:id`) — send SMS to customer when status changes to `ready` or `completed`
- Respect `do_not_text` flag (add boolean column to `users` table if not present)
- Log consent source + timestamp; always honour STOP/START (handled by Twilio's opt-out management)
- No Twilio webhook handler needed for v1 — inbound opt-out management can use Twilio's hosted opt-out page

### Phase 2 — Airtable Operations Sync
**Effort:** Small. **Value:** Operational visibility for non-technical staff.

- Add `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID` to env/secrets
- Create `artifacts/api-server/src/lib/airtable.ts` — fire-and-forget sync helper (errors logged, never thrown)
- Sync new orders to an Airtable "Orders" base on creation (POST to Airtable REST API)
- Sync onboarding/access requests to a separate "Requests" base
- This is **read-only from Airtable's perspective** — Postgres remains authoritative; Airtable is a mirror

### Phase 3 — WooCommerce Catalog Sync Validation
**Effort:** Medium. **Value:** Keeps Alavont catalog and LC WooCommerce store aligned.

- Add `WOOCOMMERCE_URL`, `WOOCOMMERCE_KEY`, `WOOCOMMERCE_SECRET` (Consumer Key/Secret from WC REST API)
- Create `artifacts/api-server/src/lib/woocommerce.ts` — fetch products from WC REST API `/wp-json/wc/v3/products`
- Add `POST /api/admin/woocommerce/sync` (admin only) — pulls WC products and upserts into `catalog_items` (matched by SKU or name)
- Add `GET /api/admin/woocommerce/validate` — compares WC product list vs local catalog, returns diff (missing, extra, mismatched price)
- Frontend: add "Sync from WooCommerce" button to Catalog Debug page (already has a WooCommerce panel)

### Phase 4 — Stripe Payment / Order Status Validation
**Effort:** Small. **Value:** Ensures payment records and order statuses stay consistent.

- Add `POST /api/admin/stripe/reconcile` (admin only) — queries Stripe for PaymentIntents linked to orders in the last N days and flags any where Stripe status and order status disagree
- Add `GET /api/admin/stripe/intent/:id` (admin only) — fetches a specific PaymentIntent's current status from Stripe for manual inspection
- Surface results in admin dashboard under a new "Payments" tab

### Phase 5 — GitHub Issue Creation for Bug Reports
**Effort:** Small. **Value:** Closes the loop between in-app feedback and the dev team.

- Add `GITHUB_TOKEN` (Personal Access Token with `repo` scope) and `GITHUB_REPO` (e.g. `orgname/myorder-fun`) to env/secrets
- Create `artifacts/api-server/src/lib/github.ts` — `createIssue(title, body, labels)` helper
- Hook into the feedback module: when an admin marks a ticket `priority_fix`, auto-create a GitHub issue with the ticket details (title, description, page URL, severity)
- Store the created issue URL on the `feedback_tickets` row (new `githubIssueUrl` column)
- Display the issue link in the admin feedback detail dialog
