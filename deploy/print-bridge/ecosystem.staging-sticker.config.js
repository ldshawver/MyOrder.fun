const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, ".env.staging-sticker");
if (!fs.existsSync(envPath) || (fs.statSync(envPath).mode & 0o777) !== 0o600) throw new Error(".env.staging-sticker must exist with mode 600");
require("dotenv").config({ path: envPath, override: true });
for (const name of ["STAGING_MYORDER_API_URL", "STAGING_STICKER_BRIDGE_ID", "STAGING_STICKER_BRIDGE_SECRET"]) if (!process.env[name]) throw new Error(`${name} is required`);

module.exports = { apps: [{
  name: "myorder-staging-marklife-pull",
  script: "staging-pull-bridge.js",
  cwd: __dirname,
  env: {
    STAGING_MYORDER_API_URL: process.env.STAGING_MYORDER_API_URL,
    STAGING_STICKER_BRIDGE_ID: process.env.STAGING_STICKER_BRIDGE_ID,
    STAGING_STICKER_BRIDGE_SECRET: process.env.STAGING_STICKER_BRIDGE_SECRET,
    STAGING_STICKER_POLL_MS: process.env.STAGING_STICKER_POLL_MS ?? "5000",
    STAGING_STICKER_STATUS_TIMEOUT_MS: process.env.STAGING_STICKER_STATUS_TIMEOUT_MS ?? "300000",
  },
  watch: false,
  autorestart: true,
  max_restarts: 10,
} ] };
