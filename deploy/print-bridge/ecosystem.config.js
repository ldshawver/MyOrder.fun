const path = require("path");
const fs = require("fs");

// PM2 is the authoritative persistent Mac launch method. start-mac.sh is a
// foreground diagnostic/manual launcher; never run both because they bind the
// same port (3100 by default).
const envPath = path.join(__dirname, ".env");
if (!fs.existsSync(envPath)) {
  throw new Error("deploy/print-bridge/.env is required");
}
if ((fs.statSync(envPath).mode & 0o777) !== 0o600) {
  throw new Error("deploy/print-bridge/.env must have permissions 600");
}

require("dotenv").config({
  path: envPath,
  override: true,
});

if (!process.env.PRINT_BRIDGE_API_KEY) {
  throw new Error("PRINT_BRIDGE_API_KEY is required in deploy/print-bridge/.env");
}

if (!process.env.PRINTER_NAME) {
  throw new Error("PRINTER_NAME is required in deploy/print-bridge/.env");
}

module.exports = {
  apps: [
    {
      name: "print-bridge",
      script: "server.js",
      cwd: __dirname,
      env: {
        PRINT_BRIDGE_API_KEY: process.env.PRINT_BRIDGE_API_KEY,
        PRINTER_NAME: process.env.PRINTER_NAME,
        CUPS_RAW: process.env.CUPS_RAW ?? "false",
        DIRECT_PRINTER_IP: "",
        DIRECT_PRINTER_PORT: "",
        USB_DEVICE: "",
        PORT: process.env.PORT ?? "3100",
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
