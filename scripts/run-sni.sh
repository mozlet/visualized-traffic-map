#!/usr/bin/env bash
# Dev: stream TLS ClientHello packets from OPNsense (stock tcpdump over ssh) and
# classify their SNI into PostgreSQL (sni_log/ip_app) + Redis. Without a
# DATABASE_URL in .env, sni-sniff prints JSON to stdout instead (debug mode).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

HOST="${OPNSENSE_SSH_HOST:-opnsense}"
IFACE="${SNI_IFACE:-ixl0}"
FILTER='tcp dst port 443 and tcp[((tcp[12]&0xf0)>>2)]=22'
BIN="./target/release/sni-sniff"
[ -x "$BIN" ] || { echo "build first: cargo build --release -p sni-sniff" >&2; exit 1; }

echo "sni: capturing ClientHellos on $HOST:$IFACE -> sni-sniff"
ssh "$HOST" /bin/sh <<EOF | "$BIN"
/usr/sbin/tcpdump -i $IFACE -n -s 0 -U -w - '$FILTER' 2>/dev/null
EOF
