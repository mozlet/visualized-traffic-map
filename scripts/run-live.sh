#!/usr/bin/env bash
# Continuous ingestion: follow OPNsense flowd.log and stream flows into
# Redis + PostgreSQL. Re-reads the whole current log on start (initial burst),
# then follows appends and log rotation.
#
# NOTE: restart re-reads the file from the top, so PostgreSQL accumulates
# duplicate rows until the recv_sec watermark is implemented (see CLAUDE.md).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

HOST="${OPNSENSE_SSH_HOST:-opnsense}"
LOG="${OPNSENSE_FLOWD_LOG:-/var/log/flowd.log}"
BIN="./target/release/ingestor"
[ -x "$BIN" ] || { echo "build first: cargo build --release -p ingestor" >&2; exit 1; }

echo "live: following $HOST:$LOG -> ingestor"
ssh "$HOST" tail -F -c +1 "$LOG" | "$BIN"
