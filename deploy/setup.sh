#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Alavont Therapeutics — First-Time VPS Setup Script
#
#  Run from the project root (as root):
#    cd /opt/alavont && bash deploy/setup.sh
# ═══════════════════════════════════════════════════════════
set -e

DOMAIN="myorder.fun"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="${PROJECT_ROOT}/deploy"

echo ""
echo "▶ Project root: ${PROJECT_ROOT}"
echo "▶ Deploy dir:   ${DEPLOY_DIR}"

echo ""
echo "▶ Installing Docker..."
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg lsb-release
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
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
echo "▶ Setting up SSH key for GitHub Actions..."
mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [ ! -f /root/.ssh/github_deploy ]; then
  ssh-keygen -t ed25519 -C 'github-deploy' -f /root/.ssh/github_deploy -N ''
fi
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
if ! grep -qxF "$(cat /root/.ssh/github_deploy.pub)" /root/.ssh/authorized_keys; then
  cat /root/.ssh/github_deploy.pub >> /root/.ssh/authorized_keys
fi
chmod 600 /root/.ssh/github_deploy
chmod 644 /root/.ssh/github_deploy.pub
echo "  ✓ Deploy public key installed in /root/.ssh/authorized_keys"
echo "  Add/update these GitHub Actions secrets before running deploy:"
echo "    VPS_USER=root"
echo "    VPS_HOST=<this VPS public IP or DNS>"
echo "    VPS_SSH_KEY=<contents of /root/.ssh/github_deploy>"
echo "  To print the private key for GitHub, run: cat /root/.ssh/github_deploy"
echo ""

echo "▶ Releasing public web ports before requesting SSL..."
bash "${DEPLOY_DIR}/release-web-ports.sh" || true

echo "▶ Obtaining SSL certificate for ${DOMAIN}..."
echo "  Make sure your DNS A record points: ${DOMAIN} → this server's IP"
echo "  Port 80 must be free (the setup script stops old proxy containers first)."
read -p "  Press Enter to get SSL cert now, or Ctrl+C to skip..."
certbot certonly --standalone \
  -d "${DOMAIN}" -d "www.${DOMAIN}" \
  --non-interactive --agree-tos \
  --register-unsafely-without-email \
  || echo "SSL skipped — run 'bash deploy/renew-cert.sh' manually later."

echo ""
echo "▶ Copying SSL certs into deploy/nginx/ssl/..."
mkdir -p "${DEPLOY_DIR}/nginx/ssl"
if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  cp "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "${DEPLOY_DIR}/nginx/ssl/fullchain.pem"
  cp "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"   "${DEPLOY_DIR}/nginx/ssl/privkey.pem"
  chmod 644 "${DEPLOY_DIR}/nginx/ssl/fullchain.pem"
  chmod 600 "${DEPLOY_DIR}/nginx/ssl/privkey.pem"
  echo "  Certs copied."
else
  echo "  No cert found — run certbot manually, then copy to ${DEPLOY_DIR}/nginx/ssl/"
fi

echo ""
echo "▶ Writing cert renewal script to ${DEPLOY_DIR}/renew-cert.sh..."
cat > "${DEPLOY_DIR}/renew-cert.sh" << RENEWSCRIPT
#!/bin/bash
# Renew Let's Encrypt cert and reload nginx.
# Called by cron — brief nginx downtime (~5s) while certbot binds port 80.
set -e
DEPLOY_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
DOMAIN="${DOMAIN}"

echo "[\$(date)] Stopping nginx to free port 80..."
cd "\${DEPLOY_DIR}"
docker compose stop nginx 2>&1 || true

echo "[\$(date)] Running certbot renewal..."
certbot renew --standalone --quiet

echo "[\$(date)] Copying renewed certs..."
cp /etc/letsencrypt/live/\${DOMAIN}/fullchain.pem "\${DEPLOY_DIR}/nginx/ssl/fullchain.pem"
cp /etc/letsencrypt/live/\${DOMAIN}/privkey.pem   "\${DEPLOY_DIR}/nginx/ssl/privkey.pem"
chmod 644 "\${DEPLOY_DIR}/nginx/ssl/fullchain.pem"
chmod 600 "\${DEPLOY_DIR}/nginx/ssl/privkey.pem"

echo "[\$(date)] Restarting nginx..."
docker compose start nginx

echo "[\$(date)] Cert renewal complete."
RENEWSCRIPT
chmod +x "${DEPLOY_DIR}/renew-cert.sh"
echo "  Done."

echo ""
echo "▶ Setting up SSL auto-renewal cron (runs at 3:15 AM on the 1st of each month)..."
(crontab -l 2>/dev/null; echo "15 3 1 * * bash ${DEPLOY_DIR}/renew-cert.sh >> /var/log/certbot-renew.log 2>&1") | crontab -
echo "  Cron set. Check with: crontab -l"

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. cd ${DEPLOY_DIR}"
echo "  2. cp .env.example .env && nano .env    # fill in all secrets"
echo "  3. docker compose build"
echo "  4. docker compose up -d db"
echo "  5. docker compose run --rm migrate"
echo "  6. docker compose up -d"
echo ""
echo "  Site will be live at https://${DOMAIN}"
echo "  After that, pushes to GitHub main branch auto-deploy."
echo "════════════════════════════════════════════════════════"
