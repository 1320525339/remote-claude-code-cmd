#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo
echo "============================================================"
echo "  Rome Client - Auto connect"
echo "============================================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install Node.js 18+."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[1/2] Installing dependencies..."
  npm install
fi

if [ ! -f "dist/cli.js" ]; then
  echo "[2/2] Building..."
  npm run build
fi

echo
echo "Auto connecting using rome.config.json ..."
echo
node bin/rome.js connect
