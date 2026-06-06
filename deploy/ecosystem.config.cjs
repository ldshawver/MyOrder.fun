const path = require("node:path");

/**
 * PM2 ecosystem config for the API server.
 *
 * BASE_DIR resolves to the repository root relative to this config file:
 *   <repo>/deploy/ecosystem.config.cjs -> <repo>
 */
const BASE_DIR = path.resolve(__dirname, "..");
const ENV_FILE = path.join(BASE_DIR, ".env");

module.exports = {
  apps: [
    {
      name: "alavont-api",
      script: "./artifacts/api-server/dist/index.mjs",
      interpreter: "node",
      node_args: `--env-file ${ENV_FILE} --enable-source-maps`,
      cwd: BASE_DIR,
      env: {
        NODE_ENV: "production",
        PORT: "8080",
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 5000,
    },
  ],
};
