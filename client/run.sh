#!/usr/bin/env bash
set -euo pipefail

# When running via docker compose, GATEWAY_URL defaults to http://localhost:1402 (same value).
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:1402}"

for SYMBOL in AAPL TSLA SOL; do
  echo ""
  echo "--- Fetching ${SYMBOL} ---"
  pay --sandbox curl "${GATEWAY_URL}/v1/quote/${SYMBOL}"
done
