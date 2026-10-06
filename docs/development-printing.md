# Development printing

This document records the verified development print path. It does not describe
or authorize production configuration.

## Verified default receipt path

Development job `15` was physically confirmed on August 5, 2026. Its path was:

1. MyOrder created a `print_jobs` record with the operator-assigned printer.
2. Operator routing profile `1` selected receipt printer `1`.
3. Printer `1` selected Mac bridge profile `1` and the explicit CUPS queue
   `Brightek_POS80` at `http://100.104.253.117:3100`.
4. MyOrder sent an authenticated HTTP `POST /print` containing the explicit
   `printerName: "Brightek_POS80"`, text format, and one copy.
5. The bridge returned HTTP 200 with `{ success: true, method: "cups",
   printer: "Brightek_POS80" }` after its synchronous `lp -d Brightek_POS80`
   submission completed successfully.
6. MyOrder recorded the job as `printed` via `mac_bridge`; the queue returned to
   enabled/idle, and the receipt was physically observed.

The printer record does not contain a credential. An empty bridge-profile
credential uses `PRINT_BRIDGE_API_KEY` from the API environment. Queue names are
required and validated; an empty or invalid queue fails closed instead of using
the bridge host's system-default CUPS destination.

The historical direct/raw CUPS attempts are not the working path. The verified
path is MyOrder HTTP bridge dispatch to the Mac, followed by an explicit,
USB-backed CUPS queue submission.

## Approved development Mac queues

- Receipt: `Brightek_POS80`, USB `usb://Brightek/POS80?serial=MHTP80E`
- Label: `Label_Themal_Printer`, USB `usb:///PL70e-BT?serial=YY41245244`

Bonjour, `dnssd`, `implicitclass`, CUPS classes, and unrelated queues are not
valid routing targets. `Avalont rpp02n` and `Beeprt_USB` are not fallbacks.

## Label status

The installed media and application renderer are both 2 inches square at 203
DPI (406×406 pixels). MyOrder sends a rendered PNG with `raw: false` and the
explicit CUPS option `media=Custom.2x2in`; it must not rely on the queue's
historical `w283h425` default.
