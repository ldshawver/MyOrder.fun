#!/usr/bin/env bash
set -euo pipefail

QUEUE_NAME="${QUEUE_NAME:-Label_Themal_Printer}"
DEVICE_MAC="${1:-${DEVICE_MAC:-}}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo DEVICE_MAC=AA:BB:CC:DD:EE:FF bash provision-pl70e-bt.sh"
  exit 1
fi

apt-get update
apt-get install -y cups cups-client bluez bluetooth bluez-cups printer-driver-all
systemctl enable --now cups
systemctl enable --now bluetooth

if [[ -z "${DEVICE_MAC}" ]]; then
  echo "Bluetooth MAC address is required."
  echo
  echo "Find it with:"
  echo "  bluetoothctl"
  echo "  scan on"
  echo
  echo "Then rerun:"
  echo "  sudo DEVICE_MAC=AA:BB:CC:DD:EE:FF bash provision-pl70e-bt.sh"
  exit 1
fi

echo "Pairing/trusting ${DEVICE_MAC}..."
bluetoothctl <<BT
power on
agent on
default-agent
pair ${DEVICE_MAC}
trust ${DEVICE_MAC}
connect ${DEVICE_MAC}
quit
BT

DEVICE_URI="bluetooth://${DEVICE_MAC}"

echo "Creating CUPS queue ${QUEUE_NAME} at ${DEVICE_URI}..."
lpadmin -x "${QUEUE_NAME}" >/dev/null 2>&1 || true
lpadmin -p "${QUEUE_NAME}" -E -v "${DEVICE_URI}" -m raw
cupsenable "${QUEUE_NAME}"
cupsaccept "${QUEUE_NAME}"

echo "Printing a label test..."
printf '=== TEST LABEL ===\nPL70e-BT queue OK\n%s\n\n\n' "$(date -Is)" | lp -d "${QUEUE_NAME}" -o raw

echo
echo "Done. Queue name: ${QUEUE_NAME}"
echo "Use LABEL_PRINTER_NAME=${QUEUE_NAME} if this queue is hosted by the bridge machine."
