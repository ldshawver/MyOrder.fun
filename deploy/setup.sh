#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Alavont Therapeutics — First-Time VPS Setup Script
#
#  Run from the project root:
#    cd /opt/alavont && bash deploy/setup.sh
# ═══════════════════════════════════════════════════════════
set -e

DOMAIN="app.alavont.com"
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
echo "  Run this to generate a deploy key (press Enter for all prompts):"
echo "  ssh-keygen -t ed25519 -C 'github-deploy' -f /root/.ssh/github_deploy"
echo "  Then add the PUBLIC key (/root/.ssh/github_deploy.pub) to:"
echo "    /root/.ssh/authorized_keys"
echo "  And add the PRIVATE key (/root/.ssh/github_deploy) to GitHub:"
echo "    Repo → Settings → Secrets → Actions → VPS_SSH_KEY"
echo ""

echo "▶ Obtaining SSL certificate for ${DOMAIN}..."
echo "  Make sure your DNS A record: ${DOMAIN} → this server's IP"
read -p "  Press Enter to get SSL cert now, or Ctrl+C to skip..."
certbot certonly --standalone -d "${DOMAIN}" --non-interactive --agree-tos \
  --register-unsafely-without-email || echo "SSL skipped — re-run certbot manually."

echo ""
echo "▶ Copying SSL certs into deploy/nginx/ssl/..."
mkdir -p "${DEPLOY_DIR}/nginx/ssl"
if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  cp "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "${DEPLOY_DIR}/nginx/ssl/fullchain.pem"
  cp "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"   "${DEPLOY_DIR}/nginx/ssl/privkey.pem"
  echo "  Certs copied."
else
  echo "  No cert found — place fullchain.pem + privkey.pem in ${DEPLOY_DIR}/nginx/ssl/ manually."
fi

echo ""
echo "▶ Setting up SSL auto-renewal cron..."
(crontab -l 2>/dev/null
 echo "0 3 * * * certbot renew --quiet && cd ${DEPLOY_DIR} && docker compose restart nginx"
) | crontab -

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. cd ${DEPLOY_DIR}"
echo "  2. cp .env.example .env && nano .env"
echo "  3. docker compose build"
echo "  4. docker compose up -d db"
echo "  5. docker compose run --rm migrate"
echo "  6. docker compose up -d"
echo ""
echo "  After that, pushes to GitHub main branch auto-deploy."
echo "════════════════════════════════════════════════════════"
