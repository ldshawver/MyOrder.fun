#!/usr/bin/env bash
# install-pi-hardened.sh — install the MyOrder print bridge on a Raspberry Pi
# (or any Debian host) as a hardened, queue-allowlisted, Tailscale-only service.
#
# Usage (as root, from this directory):
#   sudo bash install-pi-hardened.sh --queue <CUPS_QUEUE> [--allow-from 100.85.15.43] [--port 3100] [--node-bin /path/to/node]
#
#   --queue       the ONE approved CUPS queue this bridge may use (must exist)
#   --allow-from  the only Tailscale address allowed to reach the bridge (MyOrder server)
#   --node-bin    Node.js binary to run the bridge (default /usr/bin/node; Node 16+)
#
# The bridge key is generated here, written only to a root-owned file, and
# never printed; the script shows its SHA-256 fingerprint. Re-running keeps an
# existing key unless --rotate-key is given.
set -euo pipefail

QUEUE=""
ALLOW_FROM="100.85.15.43"
PORT="3100"
NODE_BIN="/usr/bin/node"
ROTATE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --queue) QUEUE="${2:-}"; shift 2 ;;
    --allow-from) ALLOW_FROM="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --node-bin) NODE_BIN="${2:-}"; shift 2 ;;
    --rotate-key) ROTATE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

APP_DIR=/opt/myorder-print-bridge
ENV_DIR=/etc/myorder-print-bridge
ENV_FILE="$ENV_DIR/bridge.env"
UNIT=/etc/systemd/system/myorder-print-bridge.service
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

fail() { echo "ABORT: $*" >&2; exit 1; }
ok() { echo "OK    $*"; }

[[ "$(id -u)" -eq 0 ]] || fail "run with sudo"
[[ "$QUEUE" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] || fail "--queue must be a CUPS queue name (letters, digits, _ . -)"
[[ "$ALLOW_FROM" =~ ^100\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "--allow-from must be a Tailscale 100.x address"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || fail "--port must be numeric"
for f in server.js queue-policy.js package.json myorder-print-bridge.service; do
  [[ -f "$SRC_DIR/$f" ]] || fail "missing $f next to this script"
done

# ── Prerequisites ────────────────────────────────────────────────────────────
command -v tailscale >/dev/null || fail "Tailscale is not installed (curl -fsSL https://tailscale.com/install.sh | sh)"
TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
[[ "$TS_IP" =~ ^100\. ]] || fail "Tailscale is not connected (run: sudo tailscale up)"
ok "Tailscale connected: $TS_IP"

[[ "$NODE_BIN" == /* && -x "$NODE_BIN" ]] || fail "Node.js not found at $NODE_BIN (use --node-bin)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 16 )) || fail "Node $NODE_MAJOR is too old; Node 16+ required"
ok "Node $("$NODE_BIN" -v) at $NODE_BIN"

apt-get update -qq >/dev/null
apt-get install -y --no-install-recommends cups cups-client ufw openssl >/dev/null
systemctl enable --now cups >/dev/null
lpstat -p "$QUEUE" >/dev/null 2>&1 || fail "CUPS queue '$QUEUE' does not exist (lpstat -p)"
ok "CUPS queue $QUEUE present"
# CUPS stays local: no sharing, no remote admin.
cupsctl --no-share-printers --no-remote-admin --no-remote-any
ok "CUPS sharing and remote admin disabled"

# ── Service account and code ─────────────────────────────────────────────────
id printbridge >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin printbridge
ok "service account printbridge"

install -d -o root -g root -m 0755 "$APP_DIR"
install -o root -g root -m 0644 "$SRC_DIR/server.js" "$SRC_DIR/queue-policy.js" "$SRC_DIR/package.json" "$APP_DIR/"
# No npm step: the bridge uses only Node built-ins (dotenv is optional and
# unused here; systemd supplies the environment).
chown -R root:root "$APP_DIR"
ok "bridge code in $APP_DIR (root-owned, read-only to the service)"

# ── Configuration (root-only) ────────────────────────────────────────────────
install -d -o root -g root -m 0700 "$ENV_DIR"
EXISTING_KEY=""
if [[ -f "$ENV_FILE" && "$ROTATE" -eq 0 ]]; then
  EXISTING_KEY="$(sed -n 's/^PRINT_BRIDGE_API_KEY=//p' "$ENV_FILE" | head -n1)"
fi
KEY="${EXISTING_KEY:-$(openssl rand -hex 32)}"
umask 077
cat > "$ENV_FILE.tmp" <<EOF
PORT=$PORT
BIND_HOST=$TS_IP
PRINTER_NAME=$QUEUE
ALLOWED_QUEUES=$QUEUE
CUPS_RAW=true
DIRECT_PRINTER_IP=
USB_DEVICE=
PRINT_BRIDGE_API_KEY=$KEY
EOF
chown root:root "$ENV_FILE.tmp"; chmod 600 "$ENV_FILE.tmp"; mv "$ENV_FILE.tmp" "$ENV_FILE"
FINGERPRINT="$(printf %s "$KEY" | sha256sum | cut -c1-8)"
unset KEY EXISTING_KEY
ok "config $ENV_FILE (root:root 600), queue allowlist: $QUEUE, bind $TS_IP:$PORT"

# ── Logs ─────────────────────────────────────────────────────────────────────
install -d -m 0755 /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\nMaxRetentionSec=14day\n' > /etc/systemd/journald.conf.d/myorder-print-bridge.conf
systemctl restart systemd-journald
ok "journald capped (100M / 14 days)"

# ── Firewall: bridge reachable only from the MyOrder server over Tailscale ───
ufw allow 22/tcp >/dev/null
ufw allow 41641/udp >/dev/null
ufw default deny incoming >/dev/null
ufw allow in on tailscale0 from "$ALLOW_FROM" to any port "$PORT" proto tcp >/dev/null
ufw --force enable >/dev/null
ok "ufw: SSH (22) and Tailscale (41641/udp) kept open; port $PORT only from $ALLOW_FROM on tailscale0"

# ── Service ──────────────────────────────────────────────────────────────────
sed "s#^ExecStart=/usr/bin/node #ExecStart=$NODE_BIN #" "$SRC_DIR/myorder-print-bridge.service" > "$UNIT"
chown root:root "$UNIT"; chmod 0644 "$UNIT"
systemctl daemon-reload
systemctl enable myorder-print-bridge >/dev/null
systemctl restart myorder-print-bridge
sleep 2
systemctl is-active --quiet myorder-print-bridge || { journalctl -u myorder-print-bridge -n 30 --no-pager; fail "service did not start"; }
ok "myorder-print-bridge active and enabled at boot"

# ── Local verification (no printing) ─────────────────────────────────────────
HEALTHZ="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$TS_IP:$PORT/healthz" || true)"
NOKEY="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$TS_IP:$PORT/health" || true)"
echo "CHECK /healthz: $HEALTHZ (expect 200)"
echo "CHECK /health without key: $NOKEY (expect 401)"
echo "CHECK pending CUPS jobs: $(lpstat -o 2>/dev/null | wc -l)"
echo
echo "Bridge key fingerprint: $FINGERPRINT (the key itself is not shown)"
echo "Register in MyOrder: Bridges -> URL http://$TS_IP:$PORT, then printer queue $QUEUE."
