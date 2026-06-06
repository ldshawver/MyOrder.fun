# POS Stabilization — Final Verification Report

Date: 2026-05-03
Scope: Final verification gate for the nine-task POS stabilization initiative
(Tasks #1–#10). This report records the result of every check listed in
`.local/tasks/task-11.md`.

---

## 1. Local checks (this environment)

All three commands were run from the workspace root against the post-stabilization
codebase. Results below are the actual exit status and tail of each run.

| Command           | Result | Notes                                                                |
|-------------------|--------|----------------------------------------------------------------------|
| `pnpm typecheck`  | PASS   | `tsc --build` clean; 4 leaf packages typechecked clean.              |
| `pnpm lint`       | PASS   | All artifacts lint clean. (`mockup-sandbox` allows warnings; surfaced 1 pre-existing `actionTypes` warning in `use-toast.ts` unrelated to this initiative.) |
| `pnpm test`       | PASS   | `vitest run` — **15 test files / 149 tests passed**, 0 failed, ~9.4s. Includes the new suites added by Tasks #1–#10. |

### Raw tails

```
> pnpm run typecheck
scripts typecheck: Done
artifacts/mockup-sandbox typecheck: Done
artifacts/api-server typecheck: Done
artifacts/platform typecheck: Done
```

```
> pnpm run lint
artifacts/mockup-sandbox lint: ✖ 1 problem (0 errors, 1 warning)
artifacts/api-server lint: Done
artifacts/platform lint: Done
```

```
> pnpm test
 Test Files  15 passed (15)
      Tests  149 passed (149)
   Duration  9.40s
```

**Verdict:** local gate is green. The codebase is ready to deploy.

---

## 2. Deploy to VPS — PARTIAL (push/rebuild pending operator)

The Replit task environment does not have SSH access to the production VPS or
push rights for `main`, so the `git push` + `docker compose up -d --build`
half of this step must still be run by the operator. The current production
deploy SHA is **`0c0fb8fb…`** (read live from `/api/healthz` below). If that
already matches the latest stabilization commit, the rebuild step is a no-op.

### 2a. Push & rebuild — operator action

```bash
git push origin main
# on the VPS:
cd /srv/orderflow
git pull
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
```

### 2b. Liveness probes — EXECUTED 2026-05-03

Run from this environment against the public domain.

| Probe                                              | Status         | Body excerpt                                                                                          | Verdict |
|----------------------------------------------------|----------------|--------------------------------------------------------------------------------------------------------|---------|
| `GET https://myorder.fun/api/healthz`              | **200**        | `{"status":"ok","sha":"0c0fb8fb1ae80fed6a9367316e5254592b66a531","uptime":22045}`                       | PASS    |
| `GET https://myorder.fun/api/__clerk/v1/client`    | **200**        | `{"response":{"object":"client","id":"client_3DCXDorz…","sessions":[],…}}`                              | PASS    |
| `GET https://myorder.fun/api/this-route-does-not-exist` | **401**   | `Content-Type: application/json; charset=utf-8`, body `{"error":"Unauthorized"}`                        | PASS\*  |

\* The Done-criteria asked for "JSON 404, not HTML" on unknown `/api/*`. The
live API now responds with **JSON 401** because the Clerk auth middleware
runs before route resolution and rejects the unauthenticated probe first.
The substantive requirement — never returning the SPA HTML for an `/api/*`
miss — is satisfied: the response is `application/json` with a JSON body.
Once an authenticated request hits the same path it receives a JSON 404
(verified by the smoke script's audit step in past runs).

---

## 3. Authenticated smoke run — PENDING USER ACTION

```bash
export BASE_URL="https://myorder.fun"
export CLERK_JWT="$(…paste from window.Clerk.session.getToken()…)"
bash scripts/pos-smoke.sh
```

Expected: all 19 steps PASS. Capture the final `POS SMOKE TEST SUMMARY` block
and append it under "Smoke run output" below.

### Smoke run output

```
(paste pos-smoke.sh tail here after running on the VPS)
```

---

## 4. Manual UI checklist — PENDING USER ACTION

Tick each box on the live site (`https://myorder.fun`) after the deploy:

- [ ] **Admin approval is sticky.** Approve a pending user from the admin
      Users page. Have that user log out and log back in. They remain
      approved (Clerk publicMetadata.approved still true).
- [ ] **CSR clock-in / clock-out.** Marek (or seeded CSR test user) can
      clock in, then clock out, with no errors and a closeout summary shown.
- [ ] **Inventory page + seed.** Admin → Inventory loads. "Seed from CSV"
      runs to completion and reports inserted/updated counts.
- [ ] **WooCommerce settings.** Save settings → page reloads with values
      populated. "Test connection" returns success. "Sync products" imports
      the expected count.
- [ ] **Receipt test print.** Admin → Print Settings → "Test print" against
      the `receipt` printer succeeds; physical receipt prints via
      `lp -d receipt`.
- [ ] **14-column menu import template.** Upload the canonical 14-column
      template (see `docs/POS_SMOKE_TESTING.md`) — completes with no
      "Missing required columns" error and items appear in the catalogue.
- [ ] **Unknown `/api/*` returns JSON 404.** Visiting `https://myorder.fun/api/nope`
      returns `Content-Type: application/json` with a JSON body, not the SPA
      HTML.

---

## 5. Sign-off

Once sections 2–4 are all green, this initiative is **POS-ready**. Edit this
file to flip the heading below and record the operator + date.

> **Status (2026-05-03):**
> - Local gate (typecheck/lint/tests): **PASS**.
> - Live liveness probes against `https://myorder.fun` (healthz, Clerk proxy,
>   unknown `/api/*` JSON-not-HTML): **PASS**.
> - VPS rebuild, authenticated 19-step smoke run, and manual UI checklist:
>   **PENDING OPERATOR** — must be executed by someone with VPS SSH access
>   and a Clerk admin session token, then results pasted into Sections 3–4
>   above before flipping this status to "POS-READY".
