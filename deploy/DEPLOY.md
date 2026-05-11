# Alavont Therapeutics — Self-Hosting & Deployment Guide

## How Deployments Work

```
You push to GitHub main
        ↓
GitHub Actions SSHes into VPS
        ↓
git reset --hard origin/main   (fresh code)
        ↓
cd /opt/alavont/deploy
docker compose build           (rebuild containers)
docker compose run --rm migrate (schema updates)
docker compose up -d           (restart services)
```

**All `docker compose` commands run from `/opt/alavont/deploy/`** — that's where `docker-compose.yml` lives.

---

## First-Time VPS Setup

### 1. Clone the repo
```bash
git clone https://github.com/ldshawver/myorder.fun.git /opt/alavont
cd /opt/alavont
```

### 2. Run setup script
```bash
bash deploy/setup.sh
```
Installs Docker and gets a free SSL certificate for `myorder.fun`.

### 3. Create `.env` in the `deploy/` folder

> **Important:** The `.env` file must live in the `deploy/` folder (next to `docker-compose.yml`).
> Docker Compose reads `.env` from the same directory as the compose file, not the repo root.

```bash
cd /opt/alavont/deploy
cp .env.example .env
nano .env
```

Fill in every value (see `.env.example` for descriptions):
- `POSTGRES_PASSWORD` — choose a strong password
- `DATABASE_URL` — `postgresql://alavont:YOUR_PASSWORD@db:5432/alavont`
- `CLERK_SECRET_KEY` + `VITE_CLERK_PUBLISHABLE_KEY` — from clerk.com
- `SESSION_SECRET` — run `openssl rand -base64 48`

### 4. Build and launch
```bash
cd /opt/alavont/deploy

docker compose build

# Start the database first
docker compose up -d db

# Create all tables (only needed on first deploy)
docker compose run --rm migrate

# Start everything
docker compose up -d
```

### 5. Promote your first admin
```bash
# See your user record (sign in to the app first)
docker compose exec db psql -U alavont alavont \
  -c "SELECT id, email, clerk_id, role, created_at FROM users ORDER BY created_at DESC LIMIT 5;"

# Promote by ID
docker compose exec api node scripts/promote-admin.mjs 1
```

---

## GitHub Actions Auto-Deploy Setup

Every push to `main` triggers an automatic deploy. You need to add three secrets in GitHub:

**GitHub → your repo → Settings → Secrets → Actions**

| Secret name | Value |
|---|---|
| `VPS_HOST` | `195.35.11.5` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | your SSH private key (see below) |

### Generating the SSH deploy key (run on VPS)
```bash
ssh-keygen -t ed25519 -C "github-deploy" -f /root/.ssh/github_deploy
# Press Enter for all prompts (no passphrase)

# Allow this key to log in
cat /root/.ssh/github_deploy.pub >> /root/.ssh/authorized_keys

# Print the PRIVATE key — copy this into GitHub secret VPS_SSH_KEY
cat /root/.ssh/github_deploy
```

After adding the secret, any push to `main` on GitHub will auto-deploy to the VPS.

---

## Updating the App (manual)

```bash
cd /opt/alavont
git fetch --all
git reset --hard origin/main

cd /opt/alavont/deploy
docker compose build
docker compose run --rm migrate
docker compose up -d
```

---

## Useful Commands (all from /opt/alavont/deploy)

| Task | Command |
|---|---|
| View API logs | `docker compose logs -f api` |
| View all logs | `docker compose logs -f` |
| Restart API | `docker compose restart api` |
| Stop all | `docker compose down` |
| Database shell | `docker compose exec db psql -U alavont alavont` |
| List tables | `docker compose exec db psql -U alavont alavont -c "\dt"` |
| Run migrations | `docker compose run --rm migrate` |
| Promote admin | `docker compose exec api node scripts/promote-admin.mjs <id>` |

---

## PM2 Bare-Metal Setup (alternative to Docker Compose)

If you are running the API directly under PM2 (without Docker) at `/root/alavont`:

### Prerequisites
```bash
# Node 20+, pnpm, pm2
node -v          # must be 20.6+ for --env-file support
npm install -g pnpm pm2
```

### First-time setup
```bash
cd /root/alavont
cp deploy/.env.example .env
nano .env        # fill in DATABASE_URL, CLERK_SECRET_KEY, etc.

# Install dependencies, push DB schema, and build everything
bash deploy/build.sh

# Start via PM2
pm2 start deploy/ecosystem.config.cjs
pm2 save         # auto-restart on reboot
pm2 startup      # install pm2 system service
```

### Deploy after a git pull
```bash
cd /root/alavont
git pull

# Rebuild (also pushes DB schema automatically)
bash deploy/build.sh

# Reload without downtime
pm2 reload alavont-api
```

### Nginx config (bare-metal)
The `deploy/nginx.conf` file is ready to use. Copy it to nginx:
```bash
sudo cp /root/alavont/deploy/nginx.conf /etc/nginx/sites-available/myorder.fun
sudo ln -sf /etc/nginx/sites-available/myorder.fun /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Useful PM2 commands
```bash
pm2 status                    # see all processes
pm2 logs alavont-api          # tail logs
pm2 logs alavont-api --lines 100  # last 100 log lines
pm2 reload alavont-api        # zero-downtime restart
pm2 restart alavont-api       # full restart
pm2 delete alavont-api        # remove process (then re-add with pm2 start)
```

---

## Troubleshooting

| Error | Fix |
|---|---|
| `relation "users" does not exist` | Run `bash deploy/build.sh` (includes schema push) |
| `Cannot find package 'bcrypt'` | Old stale build — run `bash deploy/build.sh` to rebuild from latest code |
| `DATABASE_URL must be set` | `.env` file missing or not loaded — ensure `.env` exists at `/root/alavont/.env` and run `bash deploy/build.sh` |
| `GET /` or `GET /login` returns 404 | Frontend not built or nginx root path wrong — run `bash deploy/build.sh`, then reload nginx with `deploy/nginx.conf` |
| `Cannot find module '/app/scripts/...'` | Rebuild: `docker compose build api && docker compose up -d api` |
| Nginx won't start | Check `deploy/nginx/ssl/` has `fullchain.pem` + `privkey.pem` |
| GitHub Actions fails to connect | Verify `VPS_SSH_KEY` secret and that the public key is in `/root/.ssh/authorized_keys` |

---

## HTTPS / Let's Encrypt SSL

**This is already fully set up in the codebase.** The nginx container handles:
- Automatic HTTP → HTTPS redirect (port 80 → 443)
- TLS with your Let's Encrypt certificate
- HSTS and security headers

### Getting the certificate (one-time, run on the VPS)

The `setup.sh` script does this automatically. If you need to do it manually:

```bash
# Make sure nothing is running on port 80 first
cd /opt/alavont/deploy && docker compose stop nginx

# Get the cert
certbot certonly --standalone -d myorder.fun -d www.myorder.fun \
  --non-interactive --agree-tos --register-unsafely-without-email

# Copy certs into the nginx ssl folder
mkdir -p /opt/alavont/deploy/nginx/ssl
cp /etc/letsencrypt/live/myorder.fun/fullchain.pem /opt/alavont/deploy/nginx/ssl/
cp /etc/letsencrypt/live/myorder.fun/privkey.pem   /opt/alavont/deploy/nginx/ssl/
chmod 600 /opt/alavont/deploy/nginx/ssl/privkey.pem

# Restart nginx
cd /opt/alavont/deploy && docker compose start nginx
```

### Certificate auto-renewal

`setup.sh` installs a monthly cron job that calls `deploy/renew-cert.sh`, which:
1. Stops nginx (~5 second downtime)
2. Runs `certbot renew`
3. Copies new certs to `deploy/nginx/ssl/`
4. Restarts nginx

To renew manually at any time:
```bash
bash /opt/alavont/deploy/renew-cert.sh
```

---

## Firewall
```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

## Backup Database
```bash
cd /opt/alavont/deploy
docker compose exec db pg_dump -U alavont alavont > ../backup_$(date +%Y%m%d).sql
```
