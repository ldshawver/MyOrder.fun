---
name: Router-level requireRole bug
description: Express router.use() without a path prefix runs for every request — not just route matches — so a requireRole guard there silently blocks all subsequent routers for non-privileged users.
---

## The rule
Never place `requireRole(...)` inside `router.use()` without a path prefix on a router that is mounted without a path prefix (`app.use(router)` or `parentRouter.use(subRouter)`).

**Why:** In Express 4, `router.use(fn)` (no path) runs `fn` for every request that enters the router, regardless of whether any route in that router actually matches. If `fn` sends a 403 response (as `requireRole` does on failure), the request cycle ends and no subsequent routers in the parent ever run. This silently blocks non-admin users from every route mounted after the offending router.

**How to apply:**
- `router.use(requireAuth, loadDbUser, requireDbUser, requireApproved)` — OK as router-level (these are authN/presence checks that call next() for all valid users)
- `requireRole(...)` — always attach per-route: `router.get("/path", requireRole("admin"), handler)`
- Affected files fixed: `admin.ts`, `audit.ts`, `reports.ts`, `visual-editor.ts`
- Pre-existing test failures unrelated to this: `inventory-locations-routes.test.ts` (2), `shifts-csr.test.ts` unhandled printer exception (fire-and-forget `log.warn`).
