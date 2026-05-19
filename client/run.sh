#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:1402}"

for SYMBOL in AAPL TSLA SOL; do
  echo ""
  echo "--- Fetching ${SYMBOL} ---"
  pay --sandbox curl "${GATEWAY_URL}/v1/quote/${SYMBOL}"
done
