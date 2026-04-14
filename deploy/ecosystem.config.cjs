module.exports = {
  apps: [
    {
      name: "orderflow-api",
      script: "node",
      args: "--enable-source-maps artifacts/api-server/dist/index.mjs",
      cwd: "/opt/orderflow",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
        PORT: "8080",

        // --- Fill these in ---
        DATABASE_URL: "",

        CLERK_SECRET_KEY: "",

        STRIPE_SECRET_KEY: "",
        STRIPE_PUBLISHABLE_KEY: "",

        OPENAI_API_KEY: "",

        TWILIO_ACCOUNT_SID: "",
        TWILIO_AUTH_TOKEN: "",
        TWILIO_PHONE_NUMBER: "",
        ADMIN_ALERT_PHONE: "",

        PRINT_BRIDGE_API_KEY: "",

        WC_STORE_URL: "",
        WC_CONSUMER_KEY: "",
        WC_CONSUMER_SECRET: "",

        LOG_LEVEL: "info",
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
