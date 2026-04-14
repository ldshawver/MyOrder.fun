module.exports = {
  apps: [
    {
      name: "print-bridge",
      script: "server.js",
      cwd: __dirname,
      env: {
        PRINT_BRIDGE_API_KEY: "YsFqy1xcWb0lS8arJw0T97qO6mEVM8USemwpqpP5AML",
        DIRECT_PRINTER_IP: "192.168.68.66",
        DIRECT_PRINTER_PORT: "9100",
        PORT: "3100",
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
