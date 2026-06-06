---
name: Operating rules
description: Pre-migration stabilization constraints and process rules for all future sessions.
---

## Source of truth
- GitHub = code. Pull latest before changes.
- VPS production = runtime. PostgreSQL data must be preserved.
- Replit = build/test/staging only. Never block on Replit preview or Clerk in Replit.

## Hard constraints
- No Clerk requirement in Replit dev environment
- No framework changes (stay on Vite/React/Express/Drizzle)
- No database resets, no duplicate tables, no data loss
- No UI redesigns unless explicitly requested
- No mixing Alavont + Lucifer Cruz inventory/reporting
- No editing WooCommerce-managed LC products inside MyOrder
- No hardcoded VPS paths or Replit-specific dependencies

## Every fix must include
- typecheck + build passing
- relevant tests passing
- exact VPS deploy commands
- env/migration changes called out

## Schema changes require (in order)
1. Explain issue → 2. Migration plan → 3. No data loss + rollback confirmation → 4. Approval → 5. Drizzle migration (idempotent) → never paste raw SQL unless emergency

## Priority order
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
12. Plasmic app-host ✅

## Migration target
Self-hosted OptiPlex. Build toward: documented Docker, env vars, backup/restore, SSL/proxy — no Replit-specific assumptions.
