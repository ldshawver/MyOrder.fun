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
- `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` — from Stripe dashboard
- `OPENAI_API_KEY`
- Twilio credentials
- WooCommerce credentials
- `PRINT_BRIDGE_API_KEY`

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
