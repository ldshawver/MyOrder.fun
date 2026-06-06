# POS Smoke Testing — Authenticated VPS Verification

`scripts/pos-smoke.sh` runs the 19-step POS checklist against a deployed
OrderFlow Platform VPS using a real Clerk session JWT. Use it to prove the
production system actually works end-to-end before declaring "POS-ready".

## What it does

For each of the 19 checklist steps, the script:

1. Calls the real authenticated endpoint with `Authorization: Bearer <jwt>`.
2. Captures the HTTP status, response body, and where applicable, IDs that
   feed downstream steps (`shift_id`, `order_id`, `print_job_id`).
3. Records **PASS / FAIL / SKIP** and prints the endpoint, status, response
   excerpt, and DB tables touched.
4. Exits non-zero if any step fails.

It does **not** fake printer success — if CUPS/lp returns an error, step 3,
11, 12, or 18 fails with the printer's real error message.

## Prerequisites

On the box where you run the script (your laptop or the VPS itself):

- `bash` 4+
- `curl`
- `jq` (`apt-get install jq` or `brew install jq`)

The target VPS must:

- Be reachable from where you're running the script.
- Have at least one **approved admin** user in Clerk (the JWT subject).
- Have at least one printer configured in `print_printers` if you want
  step 3 to PASS instead of SKIP. (If none exist, step 3 SKIPs instead of
  failing.)

## How to obtain a Clerk JWT

The script needs a session token belonging to an approved admin user.

### Option A — From the browser dev tools (easiest)

1. Open your VPS app in Chrome / Firefox.
2. Log in as an **approved admin** user.
3. Open DevTools → **Application** tab → **Cookies** → your domain.
4. Copy the value of the cookie named `__session` (Clerk's session JWT).
5. That's your `CLERK_JWT`.

If `__session` is HttpOnly and your cookie viewer shows it as redacted,
do this instead:

1. Open DevTools → **Network** tab.
2. Refresh the page so you see XHR / fetch requests to `/api/...`.
3. Click any request.
4. Under **Request Headers**, find `Authorization: Bearer eyJ...` (the
   Clerk SDK attaches this automatically on the frontend).
5. Copy everything after `Bearer ` — that's your JWT.

If neither shows a Bearer token (some apps rely purely on cookies), open the
**Console** tab and run:

```js
await window.Clerk.session.getToken()
```

That returns the raw JWT string. Copy it.

### Option B — From Clerk's backend SDK (CI / scripted)

If you want fully automated runs, generate a session token server-side using
Clerk's backend API in your CI pipeline. See the
[Clerk JWT templates docs](https://clerk.com/docs/backend-requests/making/jwt-templates).
Issue a token signed for an approved admin's `userId` and pass that as
`CLERK_JWT`. JWTs typically expire in 60 seconds — the script runs all 19
steps in well under that window.

## Running the script

```bash
export BASE_URL="https://your-vps.example.com"
export CLERK_JWT="eyJhbGciOiJSUzI1NiIs..."

bash scripts/pos-smoke.sh
```

You can run it from your laptop (pointing at the public VPS URL) or SSH'd
into the VPS itself and pointing at `http://localhost`.

### Sample output

```
─── STEP 1: healthz ───
PASS  step=1  GET /api/healthz  http=200

─── STEP 2: save printer settings ───
PASS  step=2  PATCH /api/print/settings  http=200  autoPrintReceipts=true

─── STEP 3: test receipt print ───
PASS  step=3  POST /api/print/printers/4/test  http=200  printer_status=printed

─── STEP 4: download catalogue template ───
PASS  step=4  GET /api/admin/products/import-template  http=200  22 columns, includes 'Par Level'

...

═══════════════════════════════════════════════════════════════════
  POS SMOKE TEST SUMMARY
═══════════════════════════════════════════════════════════════════
  Base URL : https://orderflow.example.com
  Date     : Sat May  2 19:30:14 UTC 2026
  Smoke tag: POS-SMOKE-1746210614

  PASS: 19
  FAIL: 0
  SKIP: 0

POS-READY: all 19 steps passed.
```

### Exit codes

| Code | Meaning                                                                  |
|------|--------------------------------------------------------------------------|
| 0    | All steps passed (or only safe SKIPs — script will still note this).     |
| 1    | One or more steps failed. Not POS-ready. Read the FAIL lines for cause. |
| 2    | Bad usage — missing `BASE_URL`/`CLERK_JWT` or missing `curl`/`jq`.       |

## What each step verifies

| # | Step                                | Endpoint                                        | DB tables written              |
|---|-------------------------------------|-------------------------------------------------|--------------------------------|
| 1 | healthz                             | `GET /api/healthz`                              | none                           |
| 2 | save printer settings               | `PATCH /api/print/settings`                     | `print_settings`               |
| 3 | test receipt print                  | `POST /api/print/printers/:id/test`             | `print_jobs`                   |
| 4 | download catalogue template         | `GET /api/admin/products/import-template`       | none (CSV download)            |
| 5 | upload sample catalogue (3 items)   | `POST /api/admin/products/import` (multipart)   | `catalog_items`, `audit_logs`  |
| 6 | admin catalogue lookup              | `GET /api/admin/products`                       | none                           |
| 7 | customer menu lookup                | `GET /api/catalog?mode=alavont`                 | none                           |
| 8 | clock-in                            | `POST /api/shifts/clock-in`                     | `lab_tech_shifts`, `shift_inventory_items`, `audit_logs` |
| 9 | beginning inventory persisted       | `GET /api/shifts/current`                       | none (read-back)               |
| 10| create test order                   | `POST /api/orders`                              | `orders`, `order_items`        |
| 11| auto receipt print                  | `POST /api/print/receipt/order/:orderId`        | `print_jobs`                   |
| 12| reprint receipt                     | `POST /api/print/receipt/jobs/:jobId/reprint`   | `print_jobs`, `audit_logs`     |
| 13| clock out                           | `POST /api/shifts/clock-out`                    | `lab_tech_shifts`, `shift_inventory_items`, `audit_logs` |
| 14| ending inventory persisted          | (same — body of clock-out)                      | `shift_inventory_items`        |
| 15| sold inventory calculation          | (same — `summary.inventorySummary[].quantitySold`) | none                        |
| 16| discrepancy calculation             | (same — `summary.inventorySummary[].discrepancy`)  | none                        |
| 17| restock slip generation             | `GET /api/shifts/:id/restock-slip`              | none                           |
| 18| restock slip print                  | `POST /api/shifts/:id/restock-slip/print`       | `print_jobs` (CUPS dispatch)   |
| 19| audit log check                     | `GET /api/audit?limit=200`                      | none — verifies prior writes   |

## Required audit actions (step 19)

The script PASSes step 19 only if `audit_logs` contains rows whose `action`
matches every one of: `import`, `print`, `reprint`, `clock_in`, `clock_out`.
If any are missing, you'll see e.g.:

```
FAIL  step=19  GET /api/audit?limit=200  http=200  missing actions: reprint
```

## When a step SKIPs

- **Step 3 (test print)** SKIPs if no printer rows exist in `print_printers`.
  Configure at least one printer in the admin UI, then re-run.
- **Steps 10–12** SKIP if step 5 or 6 didn't surface a smoke catalog item ID.
- **Steps 17–18** SKIP if step 8 didn't return a shift ID.

A SKIP is **not** a PASS — investigate why before declaring the system
POS-ready.

## Re-running cleanup

The smoke script tags imported items with `POS-SMOKE-<unix-ts>` so each run
creates new rows rather than colliding. Periodically clean them up with:

```sql
DELETE FROM catalog_items WHERE alavont_id LIKE 'POS-SMOKE-%' OR lucifer_cruz_id LIKE 'POS-SMOKE-%';
```

Smoke shifts and their inventory rows can be left in place — they're
real closed shifts and form part of the audit trail.

## Troubleshooting

- **All steps fail with 401**: JWT is expired or for a non-approved user.
  Refresh it via `await window.Clerk.session.getToken()` in the browser
  console and retry.
- **Step 3 / 11 / 18 fail with `lp: command not found`**: CUPS is not
  installed on the VPS. Install with `apt-get install cups-client` and
  ensure the receipt printer queue (default name: `receipt`, override via
  `RECEIPT_PRINTER_NAME`) is reachable.
- **Step 5 fails with "Missing required columns"**: your VPS is on an old
  build that doesn't yet recognize the `Par Level` column or its aliases.
  Deploy the latest commit and retry.
- **Step 11 fails with 503 "No receipt printer configured"**: configure an
  active printer with `role=receipt` via `POST /api/print/printers`.
