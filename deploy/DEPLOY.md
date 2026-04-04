# Alavont Therapeutics — Self-Hosting Guide

## Architecture
Docker Compose runs the full platform from the **project root**:
- **Nginx** — reverse proxy + SSL termination (ports 80/443)
- **API Server** — Node.js backend (internal only, never exposed)
- **Platform** — React SPA served as static files (internal only)
- **PostgreSQL** — database (internal only, never exposed)

All `docker compose` commands are run from the **project root**, not this `deploy/` folder.

---

## Requirements
- Ubuntu 22.04 or Debian 12 VPS/dedicated server
- At least 2 GB RAM, 20 GB disk
- DNS A record: `app.alavont.com` → your server's IP address
- Git installed on the server

---

## First-Time Setup

### 1. Clone the project onto the server
```bash
git clone <your-repo-url> /opt/alavont
cd /opt/alavont
```

### 2. Run the setup script (installs Docker + SSL cert)
Run from the project root:
```bash
bash deploy/setup.sh
```
This installs Docker and obtains a free SSL certificate from Let's Encrypt.

### 3. Create your environment file (at project root)
```bash
cp .env.example .env
nano .env        # fill in every value — see comments inside
```

**Critical values to set:**
| Variable | Where to get it |
|---|---|
| `CLERK_SECRET_KEY` | [clerk.com](https://dashboard.clerk.com) → API Keys |
| `VITE_CLERK_PUBLISHABLE_KEY` | Same Clerk dashboard |
| `SESSION_SECRET` | Run: `openssl rand -base64 48` |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) |
| `STRIPE_SECRET_KEY` | [dashboard.stripe.com](https://dashboard.stripe.com) |
| `TWILIO_*` | [console.twilio.com](https://console.twilio.com) |
| `POSTGRES_PASSWORD` | Choose a strong random password |

### 4. Update Clerk for your domain
In your Clerk dashboard → **Domains** → add `app.alavont.com` and switch to the production instance (use live keys in your `.env`).

### 5. Build and launch (from project root)
```bash
docker compose build
docker compose up -d
```

### 6. Run database migrations (first deploy only)
```bash
docker compose exec api sh -c 'cd /app && node lib/db/dist/migrate.mjs'
```

### 7. Verify
```bash
docker compose ps                             # all 4 containers: "Up"
curl https://app.alavont.com/api/health       # HTTP 200
```

---

## Updating the App

```bash
cd /opt/alavont
git pull
docker compose build
docker compose up -d
```

---

## Useful Commands (all from project root)

| Task | Command |
|---|---|
| View live logs | `docker compose logs -f api` |
| Restart a service | `docker compose restart api` |
| Stop everything | `docker compose down` |
| Database shell | `docker compose exec db psql -U alavont alavont` |
| Check SSL expiry | `certbot certificates` |

---

## SSL Certificate Renewal
Certbot auto-renewal is configured via cron during setup. To renew manually:
```bash
certbot renew
docker compose restart nginx
```

---

## Firewall
Only ports 80 and 443 should be publicly accessible:
```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

---

## Backup PostgreSQL
```bash
docker compose exec db pg_dump -U alavont alavont > backup_$(date +%Y%m%d).sql
```

---

## File Layout
```
/opt/alavont/                ← project root (run all commands here)
  docker-compose.yml         ← main compose file
  .env                       ← your secrets (never commit this)
  .env.example               ← template
  deploy/
    Dockerfile.api           ← API server build
    Dockerfile.platform      ← frontend build
    nginx/
      nginx.conf             ← reverse proxy config
      ssl/                   ← SSL certs go here
    setup.sh                 ← first-time setup script
```
