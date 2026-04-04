# Alavont Therapeutics — Self-Hosting Guide

## IMPORTANT: Always run commands from the project root

```
/opt/alavont/          ← ALL docker compose commands go here
  docker-compose.yml   ← main compose file (at the ROOT, not in deploy/)
  .env                 ← your secrets
  deploy/              ← Dockerfiles, nginx config, SSL certs
```

If you are inside `/opt/alavont/deploy/` move up first:
```bash
cd /opt/alavont
```

---

## First-Time Setup (complete sequence)

### Step 1 — Get the code
```bash
git clone <your-repo-url> /opt/alavont
cd /opt/alavont           # ← stay here for all commands below
```

### Step 2 — Install Docker (if not already installed)
```bash
bash deploy/setup.sh
```

### Step 3 — Create your environment file
```bash
cp .env.example .env
nano .env
```

Fill in every value. Minimum required to start:
| Variable | Value |
|---|---|
| `POSTGRES_DB` | `alavont` |
| `POSTGRES_USER` | `alavont` |
| `POSTGRES_PASSWORD` | any strong password |
| `DATABASE_URL` | `postgresql://alavont:YOUR_PASSWORD@db:5432/alavont` |
| `CLERK_SECRET_KEY` | from clerk.com dashboard |
| `VITE_CLERK_PUBLISHABLE_KEY` | from clerk.com dashboard |
| `SESSION_SECRET` | run `openssl rand -base64 48` |

### Step 4 — Build all containers
```bash
docker compose build
```

### Step 5 — Start the database first, then run migrations
```bash
# Start only the database
docker compose up -d db

# Wait ~5 seconds, then create all tables
docker compose run --rm migrate
```

You should see output like:
```
[✓] Changes applied
```

### Step 6 — Start everything
```bash
docker compose up -d
```

### Step 7 — Verify
```bash
docker compose ps                          # all containers should show "running"
curl http://localhost/api/health           # should return {"status":"ok"}
```

---

## Promote First Admin

After you sign in to the app for the first time:

```bash
# See who is in the database
docker compose exec db psql -U alavont alavont \
  -c "SELECT id, email, clerk_id, role, created_at FROM users ORDER BY created_at DESC LIMIT 5;"

# Promote by user ID (replace 1 with your actual ID)
docker compose exec api node scripts/promote-admin.mjs 1
```

Then sign out and back in to see admin controls.

---

## Updating the App

```bash
cd /opt/alavont
git pull
docker compose build
docker compose run --rm migrate          # picks up any new schema changes
docker compose up -d
```

---

## Useful Commands (all from /opt/alavont)

| Task | Command |
|---|---|
| View API logs | `docker compose logs -f api` |
| View all logs | `docker compose logs -f` |
| Restart API only | `docker compose restart api` |
| Stop everything | `docker compose down` |
| Database shell | `docker compose exec db psql -U alavont alavont` |
| List tables | `docker compose exec db psql -U alavont alavont -c "\dt"` |
| Run migrations | `docker compose run --rm migrate` |
| Promote admin | `docker compose exec api node scripts/promote-admin.mjs <id-or-email>` |

---

## Troubleshooting

**`relation "users" does not exist`**
→ Migrations haven't run. Run: `docker compose run --rm migrate`

**`Cannot find module '/app/scripts/promote-admin.mjs'`**
→ You need to rebuild the API container after the fix: `docker compose build api && docker compose up -d api`

**`version is obsolete` warning**
→ Harmless, now removed from the compose file.

**Running from wrong directory**
→ Always run from `/opt/alavont`, never from `/opt/alavont/deploy/`

**SSL / Nginx won't start**
→ Make sure `deploy/nginx/ssl/fullchain.pem` and `privkey.pem` exist. See setup.sh.

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
docker compose exec db pg_dump -U alavont alavont > backup_$(date +%Y%m%d).sql
```
