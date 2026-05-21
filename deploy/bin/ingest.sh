#!/usr/bin/env bash
# Pipe telegraf NetFlow JSON into the ingestor. systemd tracks this script's PID;
# stopping the unit tears down both ends of the pipe.
set -euo pipefail
DIR=/opt/opn-flowmap
exec telegraf --config "$DIR/telegraf/netflow.conf" \
  | INGEST_SOURCE=telegraf "$DIR/bin/ingestor"
