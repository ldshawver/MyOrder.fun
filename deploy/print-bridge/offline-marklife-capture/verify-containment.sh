#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p capture
capture_dir="$(cd capture && pwd -P)"
profile="capture/containment.sb"
report="capture/containment-report.txt"
outside="/tmp/myorder-marklife-containment-must-not-exist"
rm -f "$outside"
sed "s#@CAPTURE_DIR@#$capture_dir#g" containment-probe.sb.in > "$profile"

exec 3>"$report"
echo "timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&3
echo "architecture=$(uname -m)" >&3
echo "default_route=$(route -n get default >/dev/null 2>&1 && echo PRESENT || echo ABSENT)" >&3
echo "cups_socket=$(test -S /var/run/cups/cups.sock && echo PRESENT || echo ABSENT)" >&3
echo "cupsd_process=$(pgrep -x cupsd >/dev/null 2>&1 && echo PRESENT || echo ABSENT)" >&3
echo "marklife_usb=$(system_profiler SPUSBDataType 2>/dev/null | grep -Eiq 'MARKLIFE|X2' && echo PRESENT || echo ABSENT)" >&3

sandbox-exec -f "$profile" /bin/sh -c 'printf controlled > "$1/allowed-write"' sh "$capture_dir"
if sandbox-exec -f "$profile" /bin/sh -c 'printf forbidden > "$1"' sh "$outside" 2>/dev/null; then echo "outside_write=ALLOWED" >&3; else echo "outside_write=DENIED" >&3; fi
if sandbox-exec -f "$profile" /usr/bin/curl --connect-timeout 1 https://example.invalid >/dev/null 2>&1; then echo "network=ALLOWED" >&3; else echo "network=DENIED" >&3; fi
if sandbox-exec -f "$profile" /usr/sbin/ioreg -p IOUSB >/dev/null 2>&1; then echo "iokit=ALLOWED" >&3; else echo "iokit=DENIED" >&3; fi
if sandbox-exec -f "$profile" /usr/bin/lpstat -r >/dev/null 2>&1; then echo "cups_query=ALLOWED" >&3; else echo "cups_query=DENIED" >&3; fi
exec 3>&-

grep -Fq 'architecture=x86_64' "$report"
grep -Fq 'default_route=ABSENT' "$report"
grep -Fq 'cups_socket=ABSENT' "$report"
grep -Fq 'cupsd_process=ABSENT' "$report"
grep -Fq 'marklife_usb=ABSENT' "$report"
grep -Fq 'outside_write=DENIED' "$report"
grep -Fq 'network=DENIED' "$report"
grep -Fq 'iokit=DENIED' "$report"
grep -Fq 'cups_query=DENIED' "$report"
[[ ! -e "$outside" ]]
shasum -a 256 "$report" > capture/containment-report.sha256
echo "Containment verified. STOP: review the report and request explicit authorization before filter execution."
