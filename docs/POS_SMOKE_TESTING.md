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

## General Queue cash operations

The Shift / Queue page resolves its operational state from server-side shift
and order records. It does not use browser-local state:

- **Active CSR** means an eligible CSR shift is authoritative for newly routed
  orders. The banner shows the CSR's safe display name and shift start time.
  Eligible cash sales use that shift's existing cash ledger and register.
- **General Queue Active** means no CSR shift is authoritative. New orders use
  the tenant-scoped General Queue. Agents may view and atomically claim those
  orders, but claiming an order does not by itself create a cash drawer or
  authorize an unaudited cash payment.
- Starting an eligible CSR shift changes the authoritative banner and routing
  for new orders. Already-claimed General Queue orders keep their owner and
  cash-session context unless an authorized release or reassignment occurs.

### Manager: open and reconcile a General Queue cash session

1. Open **Shift / Queue**, then select **View General Queue**.
2. Confirm the cash-session status is **Closed**.
3. Select an active tenant register and its linked location, enter the opening
   balance, and select **Open Cash Session**.
4. Confirm the session shows **Open**, the correct register/location, opening
   time and balance, and the opening manager in the participant list.
5. At reconciliation, enter the physically counted closing balance and select
   **Reconcile & Close**. The server calculates expected cash from the opening
   balance plus canonical `cash_ledger_entries`, records any variance, closing
   actor and closing time, and closes the session.

Opening is serialized with a PostgreSQL advisory transaction lock and a
partial unique index. Concurrent requests cannot create two open sessions for
the same tenant/location/register.

### Agent: join, claim, and accept cash

1. Open **View General Queue** and select **Join Cash Session**. Joining a
   session does not pretend the agent owns a conventional CSR shift.
2. Claim an unassigned order. The claim uses a conditional update, so only one
   concurrent claimant succeeds.
3. Open the claimed order and select **Close as Cash Paid**.
4. Verify the trusted server-derived amount due, enter the amount tendered and
   optional internal note, review calculated change, and confirm only after
   receiving the cash.

The closeout transaction locks the tenant-scoped order, revalidates ownership
and payment state, calculates the balance from the order, inserts one canonical
cash-ledger entry, closes the order, updates session totals, and writes the
completion audit. An idempotency key prevents retry or double-click duplicates.

### Authorization and overrides

- A CSR on an active shift may close only an order assigned to that CSR and
  eligible shift/register.
- A General Queue agent may close only an order that agent claimed, and only
  after joining the selected open General Queue cash session.
- Merely viewing the queue or session does not grant cash-closeout authority.
- Supervisors, managers and administrators may explicitly request an audited
  override. The override does not bypass tenant, order-state, register, or open
  cash-session validation.
- Idempotent replay is limited to the original cash actor or an explicitly
  authorized supervisor override.
- All queue, user, register, location, session, order and ledger queries are
  scoped to the authenticated tenant.

Expected actionable errors include:

- `A General Queue cash session must be opened before accepting cash.`
- `Join the active General Queue cash session before accepting cash`
- `Claim this General Queue order before accepting cash`
- `Only the assigned CSR may close this order for cash`
- `Amount tendered is insufficient`
- `Another payment is pending or associated with this order`
- `Order is already paid or is not eligible for cash closeout`
- `An active General Queue cash session already exists for that register`

### Migration recovery

Migration `0038_general_queue_cash_sessions` is forward-only. It adds the
General Queue session/participant tables and additive cash-ledger columns,
backfills legacy ledger actor/tender/change values, adds indexes and
accountability constraints, and does not delete or recreate orders, shifts,
cash entries, databases, or volumes.

Do not add or run a backward migration that drops these tables or columns:
session history and its ledger foreign keys are accounting evidence. If an
application rollout fails after `0038`:

1. Leave the migrated schema and preserved volume in place.
2. Stop new cash acceptance if the running build cannot write the new required
   actor/tender/change fields.
3. Correct the application build and roll forward.
4. Validate the migration ledger and confirm every cash entry has exactly one
   accountability context: an active CSR shift or a General Queue session.
5. Reconcile any open session from its persisted opening balance and canonical
   ledger entries. Never delete the session or fabricate a balancing entry.

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
