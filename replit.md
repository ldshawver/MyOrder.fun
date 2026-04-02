# Alavont Therapeutics — OrderFlow Platform

## Overview

Alavont Therapeutics is a production-ready, security-first multi-tenant SaaS ordering platform for clinical supply chain management. Built as a pnpm workspace monorepo with TypeScript throughout.

**Company:** Alavont Therapeutics  
**Logo:** `artifacts/platform/public/alavont-logo.png`  
**Theme:** Deep navy (#0B1121) background, electric blue primary (#3B82F6), glass morphism card style

## Product Features

- **Hardened RBAC**: 4 roles — `global_admin`, `tenant_admin`, `staff`, `customer`
- **Tenant Onboarding**: Formal approval workflow (`submitted → pending_review → approved → rejected → invited → activated`), with global admin gating
- **Customer Ordering UI**: Catalog browsing, cart, checkout, order tracking with animated hourglass while pending
- **Staff/Admin Dashboards**: Order queues, user management, catalog CRUD
- **Tokenized Payments**: Stripe PaymentIntent integration (sandbox-safe fallback without keys)
- **Order Status Notifications**: Persistent notification records per user + browser push notifications
- **AI Sales Concierge**: Chat + upsell suggestions powered by live catalog data (OpenAI GPT-4o-mini)
- **MFA for Global Admin**: TOTP-based 2FA with backup codes
- **Full Audit Logging**: Every privileged action logged with actor, IP, resource
- **E2E Encryption Flag**: Client-side encrypted order notes (isEncrypted flag)
- **Mobile-First Responsive**: Bottom tab nav on mobile, sidebar on desktop, safe-area padding

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
- Tenant isolation: every DB query filters by `actor.tenantId`; `global_admin` bypasses
- Audit log on all privileged actions
- TOTP MFA for `global_admin` (via `otplib`)
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
