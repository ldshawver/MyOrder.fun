#!/bin/bash
# Mac Studio print bridge starter
# Run: bash ~/MyOrder.fun/deploy/print-bridge/start-mac.sh

cd "$(dirname "$0")"

export PRINT_BRIDGE_API_KEY="YsFqy1xcWb0lS8arJw0T97qO6mEVM8USemwpqpP5AML"
export PRINTER_NAME="Label_Themal_Printer"
export CUPS_RAW="${CUPS_RAW:-0}"
unset DIRECT_PRINTER_IP
unset DIRECT_PRINTER_PORT

echo "Starting print bridge → Mac USB label queue: $PRINTER_NAME"
node server.js
