#!/bin/bash
# Renew Let's Encrypt cert for myorder.fun and reload nginx.
# Can be run manually or triggered via GitHub Actions workflow_dispatch.
# Stops nginx briefly (~5s) so certbot can bind port 80 (standalone mode).
set -e

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
DOMAIN="${DOMAIN:-myorder.fun}"

echo "[$(date)] === Starting cert renewal for ${DOMAIN} ==="

echo "[$(date)] Stopping nginx to free port 80..."
cd "${DEPLOY_DIR}"
docker compose stop nginx 2>&1 || true
sleep 2

echo "[$(date)] Running certbot renewal..."
certbot renew --standalone --quiet --cert-name "${DOMAIN}" || \
  certbot certonly --standalone \
    -d "${DOMAIN}" -d "www.${DOMAIN}" \
    --non-interactive --agree-tos \
    --register-unsafely-without-email \
    --quiet

echo "[$(date)] Copying renewed certs into ${DEPLOY_DIR}/nginx/ssl/..."
mkdir -p "${DEPLOY_DIR}/nginx/ssl"
cp "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "${DEPLOY_DIR}/nginx/ssl/fullchain.pem"
cp "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"   "${DEPLOY_DIR}/nginx/ssl/privkey.pem"
chmod 644 "${DEPLOY_DIR}/nginx/ssl/fullchain.pem"
chmod 600 "${DEPLOY_DIR}/nginx/ssl/privkey.pem"
echo "[$(date)] Certs copied."

echo "[$(date)] Restarting nginx..."
docker compose start nginx
sleep 3

echo "[$(date)] Verifying nginx is up..."
docker compose ps nginx

echo "[$(date)] === Cert renewal complete. ==="
