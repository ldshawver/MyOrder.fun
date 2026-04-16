# Lucifer Cruz / OrderFlow Platform

## Overview

OrderFlow is a production-ready, single-tenant adult boutique ordering platform for Lucifer Cruz. Built as a pnpm workspace monorepo with TypeScript throughout. Deployed to VPS at myorder.fun. Single shared environment — all approved users share one global catalog, orders, and settings.

**Company:** Alavont Therapeutics  
**Logo:** `artifacts/platform/public/alavont-logo.png`  
**Theme:** Deep navy (#0B1121) background, electric blue primary (#3B82F6), glass morphism card style

## Product Features

- **Dual-Brand Experience**: Lucifer Cruz branding (red #DC143C, silver, black) when logged out; Alavont Therapeutics (deep navy, electric blue) when logged in. Menu toggle on catalog page switches between Alavont catalog and Lucifer Cruz WooCommerce store (set `VITE_WOOCOMMERCE_URL` env var to activate).
- **Simplified Onboarding**: Access request form collects only name, email, phone, and optional message — no company name, business type, or volume fields.
- **Customer Home = Shop Experience**: Logged-in customers land on a combined Alavont logo + AI shopping assistant + featured product grid (thumbnails). Admin/staff still see the metrics dashboard.
- **Catalog with Thumbnails**: Product grid with image thumbnails, category filter pills, and brand toggle. `mapItem()` resolves `alavontImageUrl ?? imageUrl` so CSV-imported products display thumbnails correctly. Search covers `alavontName`, `luciferCruzName`, `labName`. Empty-state messages distinguish "truly empty", "items exist but LC filter hides them", and "search/category filter hiding items". Lucifer Cruz tab shows only items with `luciferCruzName` set. Smart empty-state messages tell admins exactly what's wrong.
- **Admin Catalog Debug** (`/admin/catalog-debug`): Full diagnostic page — summary stat cards, diagnostic callouts, category breakdown, per-row visibility badges and issue flags, and a WooCommerce sync panel with credential entry. Filters to show only hidden or missing-field rows.
- **AI Concierge** (`/ai-concierge`): Full-page "high-end electric therapeutic lounge" experience — animated floating ConciergeAvatar orb (Framer Motion, blink/float/pulse), FirstTimeWelcomeModal 4-step onboarding (localStorage key `hasSeenConciergeIntro_v2`), side panel with Quick Actions + AI-suggested product tiles, and electric chat bubbles. Signed-in users land here by default (HomeRedirect).
- **Lab Tech Shift Management**: Staff (Business Sitters) clock in using a structured seeded inventory template (8 sections: Premium Smoke Collection, Intimate Gel Collection, AquaSilk, Crimson Brick Condoms, Obsidian Edge Collection, Accessories, Pharmacy, Petty Cash). Supports G (grams) and # (count) unit types. Active shift shows live grouped inventory with flagging for negative ending quantities. Admin can edit template defaults via Inventory → Shift Template tab. Orders auto-assigned to active shift.
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

## WooCommerce (Lucifer Cruz Menu)
Set `VITE_WOOCOMMERCE_URL=https://your-store.com` in environment variables to enable the Lucifer Cruz menu tab. Product cards will link directly to the WooCommerce store for checkout. The Lucifer Cruz tab shows a "not connected" banner when the env var is absent.

## UI / UX

- **Branding**: Dark navy + electric blue with glass morphism cards (`glass-card`, `card-hover-glow` CSS classes)
- **Animated Hourglass**: Canvas-based component (`AnimatedHourglass.tsx`) shown to customers while orders are pending/processing — sand particles, ring pulses, glow effects, flip animation
- **Push Notifications**: `usePushNotifications` hook — staff notified when orders are placed; customers notified when orders are ready
- **Mobile Navigation**: Bottom tab bar (Dashboard, Catalog, Orders, Concierge) + slide-over menu for additional routes
- **Loading Screen**: Pulsing Alavont logo while app identity is loading

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

## Security

- Rate limiting on all `/api` routes (15 min/300 req global, 1 min/10 req MFA, 1 hr/5 req onboarding)
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`
- RBAC middleware enforced in every route via `requireRole()`
- No tenant isolation — single tenant, all queries are global
- Audit log on all privileged actions
- TOTP MFA for `admin` (via `otplib`)
- `app.set("trust proxy", 1)` for rate-limiter behind Replit proxy

## Structure

```text
workspace/
├── artifacts/
│   ├── api-server/           # Express 5 API server (builds to dist/index.mjs)
│   └── platform/             # React + Vite frontend (served at /)
│       ├── public/
│       │   └── alavont-logo.png   # Company logo
│       └── src/
│           ├── components/
│           │   ├── layout.tsx          # Sidebar + mobile nav
│           │   └── AnimatedHourglass.tsx  # Canvas hourglass for pending orders
│           ├── hooks/
│           │   └── usePushNotifications.ts  # Browser push notification hook
│           └── pages/                  # All page components
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

## Database Schema

Tables: `tenants`, `users`, `onboarding_requests`, `catalog_items`, `orders`, `order_items`, `order_notes`, `audit_logs`, `notifications`

**Important:** `users.email` is nullable. Partial unique index: `WHERE email IS NOT NULL AND email != ''`. Always store `null` (not `""`) for missing emails.

**Numeric fields:** `price`, `subtotal`, `total`, `tax`, `unitPrice`, `totalPrice` — always call `parseFloat()` when reading from DB.

## API Routes

All routes at `/api/*`. Key route groups:

- `GET /api/healthz` — public health check
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

## Auth Pattern

Server middleware chain: `requireAuth → loadDbUser → requireDbUser → requireRole(...)`

`getOrCreateDbUser` — selects by clerkId first; inserts if absent; on conflict falls back to select-by-clerkId then select-by-email (updates clerkId if found by email).

Clerk middleware applied globally; individual routes call `requireAuth` to enforce authentication.

## Environment Variables Required

- `DATABASE_URL` — PostgreSQL connection string (provisioned by Replit)
- `SESSION_SECRET` — session signing (provisioned as Replit secret)
- `CLERK_SECRET_KEY` — Clerk backend key
- `VITE_CLERK_PUBLISHABLE_KEY` — Clerk frontend key
- `VITE_CLERK_PROXY_URL` — Clerk proxy URL (auto-set)
- `OPENAI_API_KEY` — Optional, for AI concierge (falls back to stub if missing)
- `STRIPE_SECRET_KEY` — Optional, for real payments (falls back to sandbox mode)
- `STRIPE_PUBLISHABLE_KEY` — Optional, for Stripe Elements

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

# Build API server
pnpm --filter @workspace/api-server run build
```

## TypeScript & Composite Projects

- Always typecheck from root with `pnpm run typecheck`
- `lib/api-client-react` must be built (`tsc`) before platform can typecheck
- Project references ensure correct cross-package resolution
- Zod schemas: `email: zod.string().nullable().optional()` — use `field ?? undefined` when passing to avoid null/undefined Zod rejections
