# MyOrder Print Bridge

Production HTTP print bridge for MyOrder.fun. It can run on the Raspberry Pi or Mac Studio over Tailscale and forwards print jobs to CUPS, raw USB, or a direct socket printer.

Current production target:

- Raspberry Pi 3 B+
- Tailscale IP: `100.83.99.2`
- Receipt printer: `MP-POS80`
- Receipt CUPS queue: `receipt`
- Label printer: `PL70e-BT`
- Mac label CUPS queue: `Label_Themal_Printer`
- Bridge URL used by the app: `http://100.83.99.2:3100` or the Mac Studio Tailscale URL if the label printer is Mac-hosted

## API Compatibility

The bridge accepts both current and older app payloads:

- `GET /healthz` unauthenticated lightweight health check
- `GET /health` authenticated detailed health check
- `GET /printers` authenticated CUPS queue list
- `POST /print` authenticated print job

`POST /print` accepts:

```json
{
  "role": "receipt",
  "printer": "receipt",
  "payloadBase64": "BASE64_ESC_POS_BYTES",
  "copies": 1
}
```

It also accepts older keys such as `printerName`, `text`, and `imageBase64`.

## Pi Install

On the Pi:

```bash
cd /tmp
git clone https://github.com/ldshawver/MyOrder.fun.git myorder
cd myorder/deploy/print-bridge
sudo bash install-pi.sh
sudo nano /opt/print-bridge/.env
sudo systemctl restart print-bridge
sudo systemctl status print-bridge
```

Set `/opt/print-bridge/.env` like:

```bash
PORT=3100
BIND_HOST=0.0.0.0
PRINT_BRIDGE_API_KEY=the-same-key-from-vps-deploy-env
PRINTER_NAME=receipt
CUPS_RAW=true
```

## Receipt Queue Check

On the Pi:

```bash
lpstat -p -d
printf '\033@MYORDER RECEIPT TEST\n\n\n\035V1' | lp -d receipt -o raw
```

If the queue is missing, create it through CUPS first. For most USB thermal printers this is done from the CUPS web UI at:

```text
http://100.83.99.2:631
```

or from the Pi shell using `lpadmin` after identifying the device URI with:

```bash
lpinfo -v
```

## Bridge Smoke Test

From the Pi:

```bash
bash /opt/print-bridge/smoke-test.sh http://127.0.0.1:3100 "$PRINT_BRIDGE_API_KEY" receipt
```

From the VPS or any Tailscale machine:

```bash
curl -fsS http://100.83.99.2:3100/healthz
curl -fsS -H "x-api-key: $PRINT_BRIDGE_API_KEY" http://100.83.99.2:3100/printers
```

For a Mac Studio USB label printer, run the bridge on the Mac and test it from the VPS:

```bash
# Mac Studio
cd /path/to/MyOrder.fun/deploy/print-bridge
npm install
lpstat -p -d
printf 'MYORDER MAC LABEL TEST\n\n' | lp -d Label_Themal_Printer
PRINT_BRIDGE_API_KEY="$PRINT_BRIDGE_API_KEY" PRINTER_NAME=Label_Themal_Printer CUPS_RAW=0 node server.js
```

```bash
# VPS
curl -fsS http://<mac-tailscale-ip>:3100/healthz
curl -fsS -H "x-api-key: $PRINT_BRIDGE_API_KEY" http://<mac-tailscale-ip>:3100/printers
bash /opt/alavont/deploy/print-bridge/smoke-test.sh \
  http://<mac-tailscale-ip>:3100 "$PRINT_BRIDGE_API_KEY" Label_Themal_Printer label
```

Set the VPS `/opt/alavont/deploy/.env` to match the reachable Mac Studio Tailscale address:

```bash
PRINT_BRIDGE_URL=http://<mac-tailscale-ip>:3100
PRINT_SERVER_HOST=<mac-tailscale-ip>
PRINT_BRIDGE_API_KEY=<same key used by the Mac bridge>
LABEL_PRINT_ENABLED=true
LABEL_PRINTER_NAME=Label_Themal_Printer
```

## PL70e-BT Bluetooth Provisioning

Bluetooth provisioning is intentionally separate from the receipt bridge because the PL70e-BT may be hosted by the Mac or the Pi.

If provisioning on Linux/Pi:

```bash
cd /opt/print-bridge
sudo DEVICE_MAC=AA:BB:CC:DD:EE:FF bash provision-pl70e-bt.sh
```

If you do not know the Bluetooth MAC:

```bash
bluetoothctl
scan on
```

The script creates a raw CUPS queue named `Label_Themal_Printer` unless `QUEUE_NAME` is provided.

## Mac Label Queue

Your Mac currently has:

```text
Label_Themal_Printer
receipt
```

If labels remain Mac-hosted, keep the app label method as local CUPS/Mac bridge according to where the API can reach the queue. If labels move to the Pi, run the Bluetooth provisioning script on the Pi and use bridge queue `Label_Themal_Printer`.

## Service Logs

```bash
journalctl -u print-bridge -f
```

## Security Notes

- `/print`, `/health`, and `/printers` require `x-api-key`.
- `/healthz` is intentionally unauthenticated and returns only basic health.
- Bind through Tailscale only when possible. Firewall port `3100` from public interfaces.
- Keep `PRINT_BRIDGE_API_KEY` identical on the VPS API and Pi bridge.
