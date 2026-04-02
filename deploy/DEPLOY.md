# Alavont Therapeutics — Self-Hosting Guide

## What this is
Docker Compose setup that runs the full Alavont platform on your own server:
- **Nginx** — reverse proxy + SSL termination (ports 80/443)
- **API Server** — Node.js backend (internal only)
- **Platform** — React SPA served as static files (internal only)
- **PostgreSQL** — database (internal only, never exposed)

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

### 2. Run the setup script (installs Docker + gets SSL cert)
```bash
bash deploy/setup.sh
```

### 3. Create your environment file
```bash
cd deploy
cp .env.example .env
nano .env        # fill in every value — see comments in the file
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
In your Clerk dashboard → **Domains** → add `app.alavont.com` as an authorized domain and set it as the production instance URL.

### 5. Build and launch
```bash
cd /opt/alavont/deploy
docker compose build
docker compose up -d
```

### 6. Run database migrations (first deploy only)
```bash
docker compose exec api sh -c \
  'cd /app && node --import tsx/esm lib/db/src/migrate.ts'
```

### 7. Verify
```bash
docker compose ps           # all containers should be "Up"
curl https://app.alavont.com/api/health
```

---

## Updating the App

```bash
cd /opt/alavont
git pull
cd deploy
docker compose build
docker compose up -d --no-deps --build api platform
```

---

## Useful Commands

| Task | Command |
|---|---|
| View live logs | `docker compose logs -f api` |
| Restart a service | `docker compose restart api` |
| Stop everything | `docker compose down` |
| Database shell | `docker compose exec db psql -U alavont alavont` |
| Check SSL expiry | `certbot certificates` |

---

## SSL Certificate Renewal
Certbot auto-renewal is configured via cron. To renew manually:
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

The API server, PostgreSQL, and platform container are **never** exposed directly to the internet.

---

## Backup PostgreSQL
```bash
docker compose exec db pg_dump -U alavont alavont > backup_$(date +%Y%m%d).sql
```
