#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/print-bridge}"
SERVICE_FILE="/etc/systemd/system/print-bridge.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/print-bridge/install-pi.sh"
  exit 1
fi

echo "Installing system packages..."
apt-get update
apt-get install -y cups cups-client avahi-daemon bluez bluetooth bluez-cups curl nodejs npm

echo "Enabling CUPS, Bluetooth, and Avahi..."
systemctl enable --now cups
systemctl enable --now bluetooth
systemctl enable --now avahi-daemon

echo "Preparing ${APP_DIR}..."
mkdir -p "${APP_DIR}"
cp server.js package.json print-bridge.service smoke-test.sh provision-pl70e-bt.sh env.pi.example "${APP_DIR}/"
chmod +x "${APP_DIR}/smoke-test.sh" "${APP_DIR}/provision-pl70e-bt.sh"
if [[ ! -f "${APP_DIR}/.env" ]]; then
  cp env.pi.example "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
  echo "Created ${APP_DIR}/.env. Edit PRINT_BRIDGE_API_KEY before starting the service."
fi

echo "Installing Node dependencies..."
npm --prefix "${APP_DIR}" install --omit=dev

echo "Installing systemd service..."
cp "${APP_DIR}/print-bridge.service" "${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable print-bridge

echo
echo "Next:"
echo "  1. sudo nano ${APP_DIR}/.env"
echo "  2. sudo systemctl restart print-bridge"
echo "  3. journalctl -u print-bridge -f"
echo "  4. bash ${APP_DIR}/smoke-test.sh http://127.0.0.1:3100 <api-key> receipt"
