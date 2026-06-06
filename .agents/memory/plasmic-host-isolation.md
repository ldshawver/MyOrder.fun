---
name: Plasmic host isolation
description: Why /plasmic-host must be outside ClerkProvider and how nginx is configured for it.
---

## Rule
`/plasmic-host` must be matched and rendered ABOVE `ClerkProviderWithRoutes` in the React tree — before Clerk is even imported or initialized.

## Why
Clerk initializes asynchronously from `clerk.myorder.fun` when `<ClerkProvider>` mounts. Inside the Plasmic Studio iframe, this network call may be slow or fail, stalling the canvas host before it can render. PlasmicCanvasHost needs zero Clerk/auth/layout context.

## How to apply
- `AppRoot` (in App.tsx) uses a `<Switch>` with `/plasmic-host → <PlasmicCanvasHost />` as the FIRST route, before the catch-all `<ClerkProviderWithRoutes />`.
- `Router()` (inside ClerkProviderWithRoutes) must NOT contain a `/plasmic-host` route.

## Nginx (deploy/nginx/nginx.conf)
For the `/plasmic-host` location in the outer nginx:
- `proxy_hide_header X-Frame-Options` — removes DENY from upstream
- `proxy_hide_header Content-Security-Policy` — removes upstream CSP to avoid double-CSP
- Sets a single CSP: `frame-ancestors 'self' https://studio.plasmic.app https://*.plasmic.app; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.plasmic.app; connect-src 'self' https://*.plasmic.app; worker-src blob: 'self'`

## Nginx (deploy/nginx-spa.conf)
The `/plasmic-host` location in the platform container nginx:
- No `X-Frame-Options` header
- CSP: only `frame-ancestors 'self' https://studio.plasmic.app https://*.plasmic.app`
- Its CSP is suppressed by the outer nginx's `proxy_hide_header Content-Security-Policy`
