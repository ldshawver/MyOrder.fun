#!/usr/bin/env bash
# ============================================================================
# pos-smoke.sh — Authenticated end-to-end POS verification
# ----------------------------------------------------------------------------
# Runs the 19-step POS checklist against a deployed OrderFlow Platform VPS
# using a real Clerk session JWT.
#
# Usage:
#   BASE_URL=https://your-vps.example.com \
#   CLERK_JWT=eyJhbGciOi... \
#   bash scripts/pos-smoke.sh
#
# Requires: curl, jq
# See: docs/POS_SMOKE_TESTING.md for how to obtain CLERK_JWT.
# ============================================================================

set -u

# ---- input validation ------------------------------------------------------
if [[ -z "${BASE_URL:-}" ]]; then
  echo "ERROR: BASE_URL environment variable is required" >&2
  echo "       e.g. BASE_URL=https://orderflow.example.com" >&2
  exit 2
fi
if [[ -z "${CLERK_JWT:-}" ]]; then
  echo "ERROR: CLERK_JWT environment variable is required" >&2
  echo "       See docs/POS_SMOKE_TESTING.md for how to obtain a JWT" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is not installed" >&2; exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is not installed (apt-get install jq)" >&2; exit 2
fi

BASE_URL="${BASE_URL%/}"
AUTH="Authorization: Bearer ${CLERK_JWT}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- output helpers --------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
RESULTS=()

C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'
C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'

step_header() {
  echo
  echo "${C_BOLD}${C_CYAN}─── STEP $1: $2 ───${C_RESET}"
}

record() {
  # record <step#> <pass|fail|skip> <endpoint> <status> <note>
  local n="$1" verdict="$2" ep="$3" st="$4" note="${5:-}"
  case "$verdict" in
    pass) PASS_COUNT=$((PASS_COUNT+1)); echo "${C_GREEN}PASS${C_RESET}  step=$n  $ep  http=$st  $note" ;;
    fail) FAIL_COUNT=$((FAIL_COUNT+1)); echo "${C_RED}FAIL${C_RESET}  step=$n  $ep  http=$st  $note" ;;
    skip) SKIP_COUNT=$((SKIP_COUNT+1)); echo "${C_YELLOW}SKIP${C_RESET}  step=$n  $ep  http=$st  $note" ;;
  esac
  RESULTS+=("$verdict|$n|$ep|$st|$note")
}

show_body() {
  local body_file="$1" max="${2:-400}"
  if [[ -s "$body_file" ]]; then
    echo "${C_BOLD}response:${C_RESET}"
    head -c "$max" "$body_file"
    local size; size=$(wc -c < "$body_file")
    if (( size > max )); then echo; echo "...(truncated, ${size} bytes total)"; fi
    echo
  fi
}

api_call() {
  # api_call <METHOD> <PATH> [curl args...]
  # Writes body to "$TMP/body" and returns HTTP status via stdout.
  local method="$1"; shift
  local path="$1"; shift
  local status
  status=$(curl -sS -o "$TMP/body" -w "%{http_code}" \
    -X "$method" \
    -H "$AUTH" \
    -H "Accept: application/json" \
    "$@" \
    "${BASE_URL}${path}" 2>"$TMP/curl.err" || echo "000")
  echo "$status"
}

# ============================================================================
# STEP 1 — healthz
# ============================================================================
step_header 1 "healthz"
EP="/api/healthz"
status=$(api_call GET "$EP")
if [[ "$status" == "200" ]]; then
  record 1 pass "GET $EP" "$status"
else
  record 1 fail "GET $EP" "$status" "expected 200"
  show_body "$TMP/body"
fi

# ============================================================================
# STEP 2 — printer settings save (PATCH /api/print/settings)
# ============================================================================
step_header 2 "save printer settings"
EP="/api/print/settings"
status=$(api_call PATCH "$EP" \
  -H "Content-Type: application/json" \
  --data '{"autoPrintOrders":true,"autoPrintReceipts":true,"paperWidth":"80mm","includeOperatorName":true}')
if [[ "$status" == "200" ]]; then
  saved_auto=$(jq -r '.settings.autoPrintReceipts // empty' "$TMP/body")
  record 2 pass "PATCH $EP" "$status" "autoPrintReceipts=$saved_auto"
else
  record 2 fail "PATCH $EP" "$status" "expected 200"
  show_body "$TMP/body"
fi

# ============================================================================
# STEP 3 — receipt test print
# Discover first 'receipt' printer, then POST /api/print/printers/:id/test
# ============================================================================
step_header 3 "test receipt print"
EP="/api/print/printers"
status=$(api_call GET "$EP")
PRINTER_ID=""
if [[ "$status" == "200" ]]; then
  PRINTER_ID=$(jq -r '[.printers[] | select(.role=="receipt" and .isActive==true)] | .[0].id // empty' "$TMP/body")
  if [[ -z "$PRINTER_ID" ]]; then
    PRINTER_ID=$(jq -r '.printers[0].id // empty' "$TMP/body")
  fi
fi
if [[ -z "$PRINTER_ID" ]]; then
  record 3 skip "POST $EP/:id/test" "n/a" "no printer configured (expected if first run)"
  show_body "$TMP/body"
else
  EP="/api/print/printers/${PRINTER_ID}/test"
  status=$(api_call POST "$EP" -H "Content-Type: application/json" --data '{}')
  if [[ "$status" == "200" ]]; then
    ok=$(jq -r '.ok' "$TMP/body")
    job_status=$(jq -r '.status' "$TMP/body")
    err=$(jq -r '.error // ""' "$TMP/body")
    if [[ "$ok" == "true" ]]; then
      record 3 pass "POST $EP" "$status" "printer_status=$job_status"
    else
      record 3 fail "POST $EP" "$status" "printer_status=$job_status err=$err"
      show_body "$TMP/body"
    fi
  else
    record 3 fail "POST $EP" "$status"
    show_body "$TMP/body"
  fi
fi

# ============================================================================
# STEP 4 — catalogue template download
# ============================================================================
step_header 4 "download catalogue template"
EP="/api/admin/products/import-template"
status=$(curl -sS -o "$TMP/template.csv" -w "%{http_code}" \
  -H "$AUTH" "${BASE_URL}${EP}" || echo "000")
if [[ "$status" == "200" ]]; then
  if grep -qi "Par Level" "$TMP/template.csv"; then
    cols=$(head -1 "$TMP/template.csv" | tr ',' '\n' | wc -l)
    record 4 pass "GET $EP" "$status" "${cols} columns, includes 'Par Level'"
  else
    record 4 fail "GET $EP" "$status" "missing 'Par Level' column"
    head -1 "$TMP/template.csv"
  fi
else
  record 4 fail "GET $EP" "$status"
  cp "$TMP/template.csv" "$TMP/body"; show_body "$TMP/body"
fi

# ============================================================================
# STEP 5 — catalogue import with sample data
# ============================================================================
step_header 5 "upload sample catalogue (3 items)"
SMOKE_TAG="POS-SMOKE-$(date +%s)"
SAMPLE="$TMP/sample.csv"
{
  head -1 "$TMP/template.csv" 2>/dev/null || echo "Regular Price,Menu Image URL,Menu Name,Menu Description,Menu Category,Menu In Stock,Menu ID,Menu Amount,Menu Measurement,Merchant Price,Merchant Name,Merchant Image URL,Merchant Description,Merchant Category,Merchant In Stock,Merchant ID,Merchant Created Date,Merchant Updated Date,Merchant Created By ID,Merchant Created By,Merchant SKU,Par Level"
  echo "19.99,,Smoke Item Alpha,Smoke test item alpha,Smoke,true,${SMOKE_TAG}-A,false,,,Smoke Item Alpha LC,,Lucifer alpha,Smoke,true,${SMOKE_TAG}-A,,,,,,,5"
  echo "29.99,,Smoke Item Bravo,Smoke test item bravo,Smoke,true,${SMOKE_TAG}-B,false,,,Smoke Item Bravo LC,,Lucifer bravo,Smoke,true,${SMOKE_TAG}-B,,,,,,,3"
  echo "9.99,,Smoke Item Charlie,Smoke test item charlie,Smoke,true,${SMOKE_TAG}-C,false,,,Smoke Item Charlie LC,,Lucifer charlie,Smoke,true,${SMOKE_TAG}-C,,,,,,,10"
} > "$SAMPLE"

EP="/api/admin/products/import"
status=$(curl -sS -L -o "$TMP/body" -w "%{http_code}" \
  -X POST -H "$AUTH" -F "file=@${SAMPLE}" "${BASE_URL}${EP}" || echo "000")
if [[ "$status" == "200" ]] || [[ "$status" == "201" ]]; then
  inserted=$(jq -r '.summary.inserted // .inserted // .summary.created // 0' "$TMP/body" 2>/dev/null || echo "?")
  updated=$(jq -r '.summary.updated // .updated // 0' "$TMP/body" 2>/dev/null || echo "?")
  record 5 pass "POST $EP" "$status" "inserted=$inserted updated=$updated tag=$SMOKE_TAG"
else
  record 5 fail "POST $EP" "$status"
  show_body "$TMP/body"
fi

# ============================================================================
# STEP 6 — admin catalogue lookup (item appears)
# ============================================================================
step_header 6 "admin catalogue lookup"
EP="/api/admin/products"
status=$(api_call GET "$EP")
if [[ "$status" == "200" ]]; then
  found=$(jq -r --arg tag "${SMOKE_TAG}-A" '[.products[] | select(.alavontId==$tag or .luciferCruzId==$tag or .name=="Smoke Item Alpha")] | length' "$TMP/body" 2>/dev/null || echo 0)
  total=$(jq -r '.products | length' "$TMP/body")
  if [[ "$found" -ge 1 ]]; then
    SMOKE_ITEM_ID=$(jq -r --arg tag "${SMOKE_TAG}-A" '[.products[] | select(.alavontId==$tag or .luciferCruzId==$tag or .name=="Smoke Item Alpha")] | .[0].id' "$TMP/body")
    record 6 pass "GET $EP" "$status" "found smoke item id=$SMOKE_ITEM_ID (catalog total=$total)"
  else
    record 6 fail "GET $EP" "$status" "smoke item not found in admin catalogue"
  fi
else
  record 6 fail "GET $EP" "$status"
  show_body "$TMP/body"
fi

# ============================================================================
# STEP 7 — customer menu lookup (Alavont mode visible to user)
# ============================================================================
step_header 7 "customer menu lookup"
EP="/api/catalog?mode=alavont&search=Smoke%20Item%20Alpha"
status=$(api_call GET "$EP")
if [[ "$status" == "200" ]]; then
  cnt=$(jq -r '.items | length' "$TMP/body")
  if [[ "$cnt" -ge 1 ]]; then
    record 7 pass "GET $EP" "$status" "items_returned=$cnt"
  else
    record 7 fail "GET $EP" "$status" "smoke item not visible in customer menu"
    show_body "$TMP/body"
  fi
else
  record 7 fail "GET $EP" "$status"
  show_body "$TMP/body"
fi

# ============================================================================
# STEP 8 — clock in (also fetches inventory template)
# ============================================================================
step_header 8 "clock in"
EP="/api/shifts/inventory-template"
status=$(api_call GET "$EP")
TEMPLATE_JSON="$TMP/template.json"
if [[ "$status" == "200" ]]; then
  cp "$TMP/body" "$TEMPLATE_JSON"
  tcount=$(jq -r '.template | length' "$TEMPLATE_JSON")
  echo "  inventory template rows: $tcount"
fi

# Build inventorySnapshot from template (item rows only, qty = startingQuantityDefault or 10)
SNAPSHOT="$TMP/snapshot.json"
if [[ -s "$TEMPLATE_JSON" ]]; then
  jq '{ inventorySnapshot: [ .template[] | select(.rowType=="item") | { templateItemId: .id, quantityStart: ((.startingQuantityDefault // 10) | if . == 0 then 10 else . end) } ], cashBankStart: 100 }' "$TEMPLATE_JSON" > "$SNAPSHOT"
else
  echo '{"inventorySnapshot":[],"cashBankStart":100}' > "$SNAPSHOT"
fi

EP="/api/shifts/clock-in"
status=$(api_call POST "$EP" -H "Content-Type: application/json" --data @"$SNAPSHOT")
SHIFT_ID=""
if [[ "$status" == "201" ]]; then
  SHIFT_ID=$(jq -r '.shift.id' "$TMP/body")
  inserted=$(jq -r '._debug.inventoryItemsInserted // 0' "$TMP/body")
  record 8 pass "POST $EP" "$status" "shift_id=$SHIFT_ID inv_rows=$inserted (DB: lab_tech_shifts, shift_inventory_items)"
elif [[ "$status" == "409" ]]; then
  SHIFT_ID=$(jq -r '.shift.id' "$TMP/body")
  record 8 pass "POST $EP" "$status" "already clocked in, reusing shift_id=$SHIFT_ID"
else
  record 8 fail "POST $EP" "$status"
  show_body "$TMP/body"
fi

# ============================================================================
# STEP 9 — beginning inventory save
# Beginning inventory is persisted by clock-in payload above. Verify via
# GET /api/shifts/current that quantityStart values are present.
# ============================================================================
step_header 9 "beginning inventory persisted"
EP="/api/shifts/current"
status=$(api_call GET "$EP")
if [[ "$status" == "200" ]]; then
  inv_count=$(jq -r '[.shift.inventory[] | select(.rowType=="item" and (.quantityStart // 0) > 0)] | length' "$TMP/body")
  if [[ "$inv_count" -ge 1 ]]; then
    record 9 pass "GET $EP" "$status" "beginning_inv_rows_with_qty=$inv_count"
  else
    record 9 fail "GET $EP" "$status" "no beginning inventory rows with quantityStart>0"
    show_body "$TMP/body"
  fi
else
  record 9 fail "GET $EP" "$status"
  show_body "$TMP/body"
fi

# ============================================================================
# STEP 10 — create test order
# ============================================================================
step_header 10 "create test order"
ORDER_PAYLOAD="$TMP/order.json"
ORDER_ID=""
if [[ -n "${SMOKE_ITEM_ID:-}" ]]; then
  jq -n --argjson id "$SMOKE_ITEM_ID" '{items:[{catalogItemId:$id,quantity:1}],notes:"smoke test order"}' > "$ORDER_PAYLOAD"
  EP="/api/orders"
  status=$(api_call POST "$EP" -H "Content-Type: application/json" --data @"$ORDER_PAYLOAD")
  if [[ "$status" == "200" || "$status" == "201" ]]; then
    ORDER_ID=$(jq -r '.id // .order.id // empty' "$TMP/body")
    total=$(jq -r '.total // .order.total // empty' "$TMP/body")
    record 10 pass "POST $EP" "$status" "order_id=$ORDER_ID total=$total (DB: orders, order_items)"
  else
    record 10 fail "POST $EP" "$status"
    show_body "$TMP/body"
  fi
else
  record 10 skip "POST /api/orders" "n/a" "no smoke item id from step 6"
fi

# ============================================================================
# STEP 11 — receipt auto-print (POST /api/print/receipt/order/:orderId)
# ============================================================================
step_header 11 "receipt auto-print"
RECEIPT_JOB_ID=""
if [[ -n "$ORDER_ID" ]]; then
  EP="/api/print/receipt/order/${ORDER_ID}"
  status=$(api_call POST "$EP" -H "Content-Type: application/json" --data '{}')
  if [[ "$status" == "200" ]]; then
    RECEIPT_JOB_ID=$(jq -r '.jobId' "$TMP/body")
    job_ref=$(jq -r '.jobRef // ""' "$TMP/body")
    record 11 pass "POST $EP" "$status" "job_id=$RECEIPT_JOB_ID jobRef=$job_ref (DB: print_jobs)"
  else
    err=$(jq -r '.error // ""' "$TMP/body" 2>/dev/null)
    RECEIPT_JOB_ID=$(jq -r '.jobId // ""' "$TMP/body" 2>/dev/null)
    record 11 fail "POST $EP" "$status" "err=$err"
    show_body "$TMP/body"
  fi
else
  record 11 skip "POST /api/print/receipt/order/:orderId" "n/a" "no order id"
fi

# ============================================================================
# STEP 12 — reprint receipt
# ============================================================================
step_header 12 "reprint receipt"
if [[ -n "$RECEIPT_JOB_ID" ]]; then
  EP="/api/print/receipt/jobs/${RECEIPT_JOB_ID}/reprint"
  status=$(api_call POST "$EP" -H "Content-Type: application/json" --data '{}')
  if [[ "$status" == "200" ]]; then
    new_job=$(jq -r '.jobId // .newJobId // ""' "$TMP/body")
    record 12 pass "POST $EP" "$status" "new_job_id=$new_job"
  else
    err=$(jq -r '.error // ""' "$TMP/body" 2>/dev/null)
    record 12 fail "POST $EP" "$status" "err=$err"
    show_body "$TMP/body"
  fi
else
  record 12 skip "POST /api/print/receipt/jobs/:id/reprint" "n/a" "no job id from step 11"
fi

# ============================================================================
# STEP 13 / 14 — clock out with ending inventory
# ============================================================================
step_header 13 "clock out (with ending inventory)"
ENDING="$TMP/ending.json"
EP="/api/shifts/current"
status=$(api_call GET "$EP")
if [[ "$status" == "200" ]]; then
  jq '{ endingInventory: [ .shift.inventory[] | select(.rowType=="item") | { shiftInventoryItemId: .id, quantityEndActual: (((.quantityStart // 0) - (.quantitySold // 0) - 1) | if . < 0 then 0 else . end) } ], cashBankEnd: 100 }' "$TMP/body" > "$ENDING"
else
  echo '{"endingInventory":[],"cashBankEnd":100}' > "$ENDING"
fi

EP="/api/shifts/clock-out"
status=$(api_call POST "$EP" -H "Content-Type: application/json" --data @"$ENDING")
CLOSEOUT_BODY="$TMP/closeout.json"
if [[ "$status" == "200" ]]; then
  cp "$TMP/body" "$CLOSEOUT_BODY"
  shift_status=$(jq -r '.shift.status' "$CLOSEOUT_BODY")
  record 13 pass "POST $EP" "$status" "shift_status=$shift_status (DB: lab_tech_shifts)"
else
  record 13 fail "POST $EP" "$status"
  show_body "$TMP/body"
fi

# Step 14: ending inventory saved (from same clock-out call)
step_header 14 "ending inventory persisted"
if [[ -s "$CLOSEOUT_BODY" ]]; then
  end_count=$(jq -r '[.summary.inventorySummary[] | select(.rowType=="item" and .quantityEndActual != null)] | length' "$CLOSEOUT_BODY")
  if [[ "$end_count" -ge 1 ]]; then
    record 14 pass "POST /api/shifts/clock-out" "200" "ending_actual_rows=$end_count"
  else
    record 14 fail "POST /api/shifts/clock-out" "200" "no rows with quantityEndActual set"
  fi
else
  record 14 skip "POST /api/shifts/clock-out" "n/a" "no closeout body"
fi

# Step 15: sold inventory calculation
step_header 15 "sold inventory calculation"
if [[ -s "$CLOSEOUT_BODY" ]]; then
  sold_total=$(jq -r '[.summary.inventorySummary[].quantitySold // 0] | add // 0' "$CLOSEOUT_BODY")
  total_orders=$(jq -r '.summary.totalOrders // 0' "$CLOSEOUT_BODY")
  if [[ -n "$sold_total" ]]; then
    record 15 pass "(closeout summary)" "200" "sold_total=$sold_total total_orders=$total_orders"
  else
    record 15 fail "(closeout summary)" "200" "no quantitySold values"
  fi
else
  record 15 skip "(closeout summary)" "n/a" "no closeout body"
fi

# Step 16: discrepancy calculation
step_header 16 "discrepancy calculation"
if [[ -s "$CLOSEOUT_BODY" ]]; then
  disc_rows=$(jq -r '[.summary.inventorySummary[] | select(.discrepancy != null)] | length' "$CLOSEOUT_BODY")
  cash_disc=$(jq -r '.summary.cashDiscrepancy // "null"' "$CLOSEOUT_BODY")
  if [[ "$disc_rows" -ge 1 ]]; then
    record 16 pass "(closeout summary)" "200" "discrepancy_rows=$disc_rows cash_discrepancy=$cash_disc"
  else
    record 16 fail "(closeout summary)" "200" "no discrepancy values computed"
  fi
fi

# ============================================================================
# STEP 17 — restock slip generation
# ============================================================================
step_header 17 "restock slip generation"
if [[ -n "$SHIFT_ID" ]]; then
  EP="/api/shifts/${SHIFT_ID}/restock-slip"
  status=$(api_call GET "$EP")
  if [[ "$status" == "200" ]]; then
    n=$(jq -r '.totalItemsNeedingRestock' "$TMP/body")
    record 17 pass "GET $EP" "$status" "items_needing_restock=$n"
  else
    record 17 fail "GET $EP" "$status"
    show_body "$TMP/body"
  fi
else
  record 17 skip "GET /api/shifts/:id/restock-slip" "n/a" "no shift id"
fi

# ============================================================================
# STEP 18 — restock slip print
# ============================================================================
step_header 18 "restock slip print"
if [[ -n "$SHIFT_ID" ]]; then
  EP="/api/shifts/${SHIFT_ID}/restock-slip/print"
  status=$(api_call POST "$EP" -H "Content-Type: application/json" --data '{}')
  if [[ "$status" == "200" ]]; then
    printed=$(jq -r '.printed' "$TMP/body")
    msg=$(jq -r '.message // .jobRef // ""' "$TMP/body")
    if [[ "$printed" == "true" ]]; then
      record 18 pass "POST $EP" "$status" "printed=true ref=$msg"
    else
      record 18 pass "POST $EP" "$status" "printed=false (nothing needs restock: $msg)"
    fi
  else
    err=$(jq -r '.error // ""' "$TMP/body" 2>/dev/null)
    record 18 fail "POST $EP" "$status" "err=$err"
    show_body "$TMP/body"
  fi
else
  record 18 skip "POST /api/shifts/:id/restock-slip/print" "n/a" "no shift id"
fi

# ============================================================================
# STEP 19 — audit log check
# ============================================================================
step_header 19 "audit log check"
EP="/api/audit?limit=200"
status=$(api_call GET "$EP")
if [[ "$status" == "200" ]]; then
  total=$(jq -r '.total' "$TMP/body")
  actions=$(jq -r '[.entries[].action] | unique | join(",")' "$TMP/body")
  echo "  audit total=$total"
  echo "  recent_actions=$actions"

  # Required action keywords (regex-friendly)
  required=("import" "print" "reprint" "clock_in" "clock_out" "closeout|clock_out")
  missing=()
  for needle in "${required[@]}"; do
    if ! echo "$actions" | grep -qiE "$needle"; then
      missing+=("$needle")
    fi
  done

  if [[ ${#missing[@]} -eq 0 ]]; then
    record 19 pass "GET $EP" "$status" "all required actions present (DB: audit_logs)"
  else
    record 19 fail "GET $EP" "$status" "missing actions: ${missing[*]}"
  fi
else
  record 19 fail "GET $EP" "$status"
  show_body "$TMP/body"
fi

# ============================================================================
# Summary
# ============================================================================
echo
echo "${C_BOLD}═══════════════════════════════════════════════════════════════════${C_RESET}"
echo "${C_BOLD}  POS SMOKE TEST SUMMARY${C_RESET}"
echo "${C_BOLD}═══════════════════════════════════════════════════════════════════${C_RESET}"
echo "  Base URL : $BASE_URL"
echo "  Date     : $(date)"
echo "  Smoke tag: $SMOKE_TAG"
echo
echo "  ${C_GREEN}PASS:${C_RESET} $PASS_COUNT"
echo "  ${C_RED}FAIL:${C_RESET} $FAIL_COUNT"
echo "  ${C_YELLOW}SKIP:${C_RESET} $SKIP_COUNT"
echo
printf "%-6s %-4s %-8s %s\n" "STEP" "RES" "STATUS" "ENDPOINT"
printf "%-6s %-4s %-8s %s\n" "----" "---" "------" "--------"
for r in "${RESULTS[@]}"; do
  IFS='|' read -r v n ep st note <<< "$r"
  case "$v" in
    pass) col="${C_GREEN}PASS${C_RESET}" ;;
    fail) col="${C_RED}FAIL${C_RESET}" ;;
    skip) col="${C_YELLOW}SKIP${C_RESET}" ;;
  esac
  printf "%-6s %-13s %-8s %s\n" "$n" "$col" "$st" "$ep"
done
echo

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "${C_RED}${C_BOLD}NOT POS-READY: $FAIL_COUNT step(s) failed.${C_RESET}"
  exit 1
fi
if [[ "$SKIP_COUNT" -gt 0 ]]; then
  echo "${C_YELLOW}${C_BOLD}CONDITIONAL PASS: $SKIP_COUNT step(s) skipped — investigate before declaring POS-ready.${C_RESET}"
  exit 0
fi
echo "${C_GREEN}${C_BOLD}POS-READY: all 19 steps passed.${C_RESET}"
exit 0
