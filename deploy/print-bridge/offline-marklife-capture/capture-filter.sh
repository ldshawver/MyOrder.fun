#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
capture_dir="$(cd capture && pwd -P)"
report="capture/containment-report.txt"
gate="capture/OPERATOR_AUTHORIZATION"
profile="capture/filter.sb"

[[ -f "$report" && -f capture/containment-report.sha256 ]]
shasum -a 256 -c capture/containment-report.sha256
report_sha="$(awk '{print $1}' capture/containment-report.sha256)"
[[ -f "$gate" ]]
[[ "$(cat "$gate")" == "AUTHORIZED_CONTAINMENT_REPORT_SHA256=$report_sha" ]]
grep -Fq 'default_route=ABSENT' "$report"
grep -Fq 'cups_socket=ABSENT' "$report"
grep -Fq 'cupsd_process=ABSENT' "$report"
grep -Fq 'marklife_usb=ABSENT' "$report"
grep -Fq 'outside_write=DENIED' "$report"
grep -Fq 'network=DENIED' "$report"
grep -Fq 'iokit=DENIED' "$report"
grep -Fq 'cups_query=DENIED' "$report"

filter_path="$(pwd -P)/input/vendor/rastertoX2"
sed -e "s#@CAPTURE_DIR@#$capture_dir#g" -e "s#@FILTER_PATH@#$filter_path#g" filter.sb.in > "$profile"
options="$(cat filter-options.txt)"
export PPD="$(pwd -P)/input/vendor/MARKLIFE_X2.ppd"

echo "Execution remains intentionally unimplemented until the exact upstream PNG-to-CUPS-raster filter is identified and captured." >&2
echo "No vendor filter was executed." >&2
exit 3
