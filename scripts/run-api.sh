#!/usr/bin/env bash
# Start the HTTP + WebSocket API serving the traffic map frontend.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

BIN="./target/release/api"
[ -x "$BIN" ] || { echo "build first: cargo build --release -p api" >&2; exit 1; }

export API_BIND="${API_BIND:-0.0.0.0:8088}"
export FRONTEND_DIR="${FRONTEND_DIR:-web/dist}"
echo "api: http://$API_BIND  (open this in a browser)"
exec "$BIN"
