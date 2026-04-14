#!/bin/bash
# Mac Studio print bridge starter
# Run: bash ~/MyOrder.fun/deploy/print-bridge/start-mac.sh

cd "$(dirname "$0")"

export PRINT_BRIDGE_API_KEY="YsFqy1xcWb0lS8arJw0T97qO6mEVM8USemwpqpP5AML"
export DIRECT_PRINTER_IP="192.168.68.66"
export DIRECT_PRINTER_PORT="9100"

echo "Starting print bridge → receipt printer at $DIRECT_PRINTER_IP:$DIRECT_PRINTER_PORT"
node server.js
