#!/usr/bin/env bash
# Continuous ingestion via telegraf inputs.netflow:
#   OPNsense pflow -> samplicate -> u0:2055 -> telegraf -> ingestor -> PG/Redis
#
# NetFlow v9 sends templates periodically; telegraf cannot decode flows until it
# has seen a template. On a fresh start, decoded flows may not appear for up to a
# minute. To force an immediate template (re)send:
#   ssh opnsense 'configctl template reload OPNsense/Netflow; configctl netflow restart'
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

command -v telegraf >/dev/null || { echo "telegraf not installed" >&2; exit 1; }
[ -x ./target/release/ingestor ] || { echo "build first: cargo build --release -p ingestor" >&2; exit 1; }

echo "live(telegraf): netflow udp:2055 -> ingestor -> PG/Redis"
telegraf --config telegraf/netflow.conf 2>/tmp/telegraf-netflow.err \
  | INGEST_SOURCE=telegraf ./target/release/ingestor
