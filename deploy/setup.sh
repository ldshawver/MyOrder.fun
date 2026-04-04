#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Alavont Therapeutics — Server Setup Script
#  Run once on a fresh Ubuntu 22.04 / Debian 12 server.
#
#  Usage (from the project root on the server):
#    bash deploy/setup.sh
# ═══════════════════════════════════════════════════════════
set -e

DOMAIN="app.alavont.com"
DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # project root

echo ""
echo "▶ Project root detected: ${DEPLOY_DIR}"

echo ""
echo "▶ Installing Docker..."
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg lsb-release
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker

echo ""
echo "▶ Installing Certbot (Let's Encrypt SSL)..."
apt-get install -y -qq certbot

echo ""
echo "▶ Obtaining SSL certificate for ${DOMAIN}..."
echo "   (Make sure your DNS A record points ${DOMAIN} → this server's IP first!)"
read -p "   Press Enter to continue, Ctrl+C to skip SSL setup..."
certbot certonly --standalone -d "${DOMAIN}" --non-interactive --agree-tos \
  --register-unsafely-without-email || echo "SSL cert skipped — re-run certbot manually when DNS is ready."

echo ""
echo "▶ Copying SSL certs to deploy/nginx/ssl/ ..."
mkdir -p "${DEPLOY_DIR}/deploy/nginx/ssl"
if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  cp "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "${DEPLOY_DIR}/deploy/nginx/ssl/fullchain.pem"
  cp "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"   "${DEPLOY_DIR}/deploy/nginx/ssl/privkey.pem"
  echo "   SSL certs copied."
else
  echo "   No cert found — place fullchain.pem and privkey.pem in deploy/nginx/ssl/ manually."
fi

echo ""
echo "▶ Setting up auto-renewal cron for SSL..."
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && docker compose -f ${DEPLOY_DIR}/docker-compose.yml restart nginx") | crontab -

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Next steps (all from the project root: ${DEPLOY_DIR}):"
echo ""
echo "  1. cd ${DEPLOY_DIR}"
echo "  2. cp .env.example .env"
echo "  3. nano .env           (fill in all secrets)"
echo "  4. docker compose build"
echo "  5. docker compose up -d"
echo ""
echo "  To run DB migrations (first deploy only):"
echo "  docker compose exec api sh -c 'cd /app && node lib/db/dist/migrate.mjs'"
echo ""
echo "  App will be live at https://${DOMAIN}"
echo "════════════════════════════════════════════════════════"
