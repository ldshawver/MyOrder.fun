/**
 * PM2 Ecosystem Config — Alavont API Server
 *
 * The app lives in /root/alavont (or wherever you cloned the repo).
 * All secrets are loaded from /root/alavont/.env via Node's --env-file flag.
 *
 * First-time start:
 *   cd /root/alavont
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 save
 *
 * Update after a pull + rebuild:
 *   pm2 reload alavont-api
 *
 * If the app root is NOT /root/alavont, edit BASE_DIR below.
 */

const BASE_DIR = "/root/alavont";

module.exports = {
  apps: [
    {
      name: "alavont-api",
      // Node 20.6+ supports --env-file natively.
      // All secrets (DATABASE_URL, CLERK_SECRET_KEY, etc.) must be in BASE_DIR/.env
      script: "node",
      args: `--env-file ${BASE_DIR}/.env --enable-source-maps artifacts/api-server/dist/index.mjs`,
      interpreter: "none",
      cwd: BASE_DIR,
      // Only override the two vars that should always be production regardless of .env
      env: {
        NODE_ENV: "production",
        PORT: "8080",
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
