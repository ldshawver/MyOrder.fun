# VPS Deployment Guide

## Prerequisites on the VPS

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- PM2 (`npm install -g pm2`)
- Nginx
- Certbot (for SSL)

---

## 1. Clone / copy the project

```bash
git clone <your-repo-url> /opt/orderflow
cd /opt/orderflow
```

Or rsync from your local machine:

```bash
rsync -avz --exclude node_modules --exclude .git . user@yourserver:/opt/orderflow/
```

---

## 2. Build

```bash
bash /opt/orderflow/deploy/build.sh
```

---

## 3. Configure environment variables

Edit `deploy/ecosystem.config.cjs` and fill in all the empty `""` values:

- `DATABASE_URL` — your PostgreSQL connection string
- `CLERK_SECRET_KEY` — from Clerk dashboard
- `PAYMENT_PROVIDER=paypal`
- `PAYMENT_MODE=disabled|sandbox|live` — fail-closed online-payment mode
- `PAYPAL_ENVIRONMENT=sandbox|live` — must exactly match `PAYMENT_MODE` when enabled
- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` — REST application credentials
- `PAYPAL_WEBHOOK_ID` — ID assigned to the configured `/api/webhooks/paypal` webhook
- `OPENAI_API_KEY`
- Twilio credentials
- WooCommerce credentials
- `PRINT_BRIDGE_API_KEY`

Do not configure a PayPal API base URL. The application selects the Sandbox or
live host internally. Staging must use `PAYMENT_MODE=sandbox` and
`PAYPAL_ENVIRONMENT=sandbox`; startup rejects live payments in staging.

Stripe is not an online payment provider for this release. Its legacy API
routes fail closed and the Stripe environment variables remain empty.

---

## 4. Start the API server with PM2

```bash
cd /opt/orderflow
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

---

## 5. Set up Nginx

```bash
# Copy the config
cp /opt/orderflow/deploy/nginx.conf /etc/nginx/sites-available/myorder.fun
ln -s /etc/nginx/sites-available/myorder.fun /etc/nginx/sites-enabled/

# Get SSL certificate
certbot --nginx -d myorder.fun -d www.myorder.fun

# Reload nginx
nginx -t && systemctl reload nginx
```

---

## Updating / redeploying

```bash
cd /opt/orderflow
git pull                         # or rsync new files
bash deploy/build.sh             # rebuild
pm2 restart orderflow-api        # restart the API server
```

Nginx serves the static frontend directly from disk, so no restart needed there after a rebuild.
