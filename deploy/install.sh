#!/usr/bin/env bash
# Install the traffic-map stack as systemd services under /opt/opn-flowmap.
# Containers (PostgreSQL/Redis) stay on the existing podman compose stack.
# Run from the repo root: sudo-capable shell required.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
PREFIX=/opt/opn-flowmap

echo "== building release binaries + frontend =="
cargo build --release -p api -p ingestor -p geo-doctor -p mtr-worker -p sni-sniff
npm --prefix web run build

echo "== installing to $PREFIX =="
sudo mkdir -p "$PREFIX"/{bin,web,telegraf}
sudo systemctl stop opn-flowmap-api.service 2>/dev/null || true
sudo cp target/release/api target/release/ingestor target/release/geo-doctor target/release/mtr-worker target/release/sni-sniff "$PREFIX/bin/"
sudo cp deploy/bin/ingest.sh deploy/bin/sni.sh "$PREFIX/bin/" && sudo chmod +x "$PREFIX/bin/ingest.sh" "$PREFIX/bin/sni.sh"
sudo cp telegraf/netflow.conf "$PREFIX/telegraf/"
sudo rsync -a --delete web/dist/ "$PREFIX/web/"

echo "== env file /etc/default/opn-flowmap (from .env) =="
if [ -f .env ]; then set -a; . ./.env; set +a; fi
sudo tee /etc/default/opn-flowmap >/dev/null <<EOF
DATABASE_URL=${DATABASE_URL:-postgres://flowmap:flowmap@127.0.0.1:5432/flowmap}
REDIS_URL=${REDIS_URL:-redis://127.0.0.1:6379}
GEOIP_DB_PATH=${GEOIP_DB_PATH:-/var/lib/GeoIP/GeoLite2-City.mmdb}
HOME_LAT=${HOME_LAT:-0.0}
HOME_LON=${HOME_LON:-0.0}
OPNSENSE_SSH_HOST=${OPNSENSE_SSH_HOST:-opnsense}
SNI_IFACE=${SNI_IFACE:-ixl0}
SNI_IFACES=${SNI_IFACES:-ixl0 ixl3 igb0}
EOF
sudo chmod 0640 /etc/default/opn-flowmap

echo "== installing systemd units =="
# Retire the old single SNI unit in favour of the per-interface template.
sudo systemctl disable --now opn-flowmap-sni.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/opn-flowmap-sni.service
sudo cp deploy/opn-flowmap-api.service deploy/opn-flowmap-ingest.service \
        deploy/opn-flowmap-mtr.service deploy/opn-flowmap-sni@.service \
        deploy/opn-flowmap-geodoctor.service deploy/opn-flowmap-geodoctor.timer \
        /etc/systemd/system/
sudo chmod -R go+rX "$PREFIX"
sudo systemctl daemon-reload
sudo systemctl enable --now opn-flowmap-api.service opn-flowmap-ingest.service \
        opn-flowmap-mtr.service opn-flowmap-geodoctor.timer
# One SNI sniffer instance per LAN interface.
for IF in ${SNI_IFACES:-ixl0 ixl3 igb0}; do
        sudo systemctl enable --now "opn-flowmap-sni@$IF.service"
done

echo "== status =="
systemctl --no-pager --lines=0 status opn-flowmap-api opn-flowmap-ingest opn-flowmap-mtr opn-flowmap-geodoctor.timer || true
for IF in ${SNI_IFACES:-ixl0 ixl3 igb0}; do systemctl --no-pager --lines=0 status "opn-flowmap-sni@$IF" || true; done
echo "done. open http://<u0>:8088"
