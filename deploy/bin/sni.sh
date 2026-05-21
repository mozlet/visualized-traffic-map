#!/usr/bin/env bash
# Stream TLS ClientHello packets from OPNsense's stock tcpdump over ssh and
# classify their SNI on u0. No custom binary runs on the firewall. The BPF
# filter keeps only TCP→443 packets whose first payload byte is 0x16 (handshake),
# i.e. mostly ClientHellos. systemd tracks this PID; tcpdump dies via SIGPIPE
# when the pipe closes. SNI_IFACE selects the LAN interface to watch.
set -euo pipefail
DIR=/opt/opn-flowmap
HOST="${OPNSENSE_SSH_HOST:-opnsense}"
# Interface from $1 (systemd template %i) else $SNI_IFACE else default.
IFACE="${1:-${SNI_IFACE:-ixl0}}"
FILTER='tcp dst port 443 and tcp[((tcp[12]&0xf0)>>2)]=22'

ssh "$HOST" /bin/sh <<EOF | "$DIR/bin/sni-sniff"
/usr/sbin/tcpdump -i $IFACE -n -s 0 -U -w - '$FILTER' 2>/dev/null
EOF
