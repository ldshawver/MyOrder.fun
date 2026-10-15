# Staging Clerk configuration

Staging Compose builds the platform bundle with a publishable key and proxy URL
from the Compose secrets, and supplies the same `CLERK_PUBLISHABLE_KEY` source
to the API. Do not print either value while validating deployment configuration.

The platform uses the proxy only for a production build with a non-development
(`pk_live_`) key. The API omits `proxyUrl` for `pk_test_` keys, and otherwise
currently passes the proxy URL only when `NODE_ENV` is `production`. Staging
sets `NODE_ENV=staging`, so the required configurations are:

- Preferred staging configuration: use the staging Clerk development instance
  (`pk_test_` key). Both frontend and API bypass proxying, and the staging
  image's development Frontend API allowance is appropriate.
- If staging intentionally uses a live Clerk instance, the API and frontend
  proxy behavior is currently mismatched. Do not deploy until the API is
  configured to use the same staging proxy URL for live keys in staging, with
  JWT verification unchanged, and this path is tested.

Staging Compose must pass `MYORDER_OWNER_CLERK_ID` explicitly to the API. The
required Compose interpolation fails closed if it is absent. The value must be
the configured owner's exact immutable Clerk subject, stored only in secure
deployment configuration. Do not derive it from email, role, or Clerk metadata.

Before staging validation, confirm the effective frontend and API key types
match, the proxy mode is consistent, the owner subject is present (without
printing it), and the API is using the P0 approval-provenance schema.
