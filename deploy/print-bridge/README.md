# Alavont Print Bridge

Lightweight Node.js HTTP server that runs on the Ubuntu VPS and accepts print jobs from the Alavont API server, forwarding them to a locally connected thermal printer via raw USB or CUPS.

## Requirements

- Node.js 18+
- USB thermal printer (e.g. PL70e) OR a CUPS-managed printer

## Quick Setup

```bash
# 1. Copy files to VPS
scp -r deploy/print-bridge/ user@195.35.11.5:/opt/print-bridge

# 2. Install deps
cd /opt/print-bridge && npm install

# 3. Configure
cp .env.example .env
nano .env   # set PRINT_BRIDGE_API_KEY, PRINTER_NAME, USB_DEVICE

# 4. Test run
node server.js

# 5. Install as systemd service
sudo cp print-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now print-bridge
sudo systemctl status print-bridge
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default 3100) | HTTP port |
| `PRINT_BRIDGE_API_KEY` | Yes | Must match `PRINT_BRIDGE_API_KEY` in Alavont API .env |
| `PRINTER_NAME` | For CUPS | CUPS printer name (run `lpstat -p` to list) |
| `USB_DEVICE` | For USB | Path to device, e.g. `/dev/usb/lp0` |

At least one of `PRINTER_NAME` or `USB_DEVICE` must be set.

## API

### POST /print

Receives a print job. Body (JSON):

```json
{
  "jobId": 42,
  "printerName": "PL70e",
  "format": "text",
  "text": "...",
  "copies": 1
}
```

### GET /health

Returns printer status and connection info.

## USB Permissions

If the device file is not accessible:

```bash
sudo usermod -aG lp $USER
# or
sudo chmod 666 /dev/usb/lp0
```

## Nginx (optional — for HTTPS)

Add to your nginx.conf if you want to expose the bridge only internally via nginx:

```nginx
location /print-bridge/ {
  proxy_pass http://127.0.0.1:3100/;
  allow 127.0.0.1;
  deny all;
}
```
