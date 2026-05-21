#!/usr/bin/env bash
# Download / refresh the MaxMind GeoLite2-City database.
# Requires a free MaxMind license key. Get one at:
#   https://www.maxmind.com/en/geolite2/signup
# Then set MAXMIND_LICENSE_KEY (in .env or the environment).
set -euo pipefail

cd "$(dirname "$0")/.."
# Load .env if present (for MAXMIND_LICENSE_KEY).
if [ -f .env ]; then set -a; . ./.env; set +a; fi

: "${MAXMIND_LICENSE_KEY:?set MAXMIND_LICENSE_KEY in .env or the environment}"
DEST_DIR="${GEOIP_DB_DIR:-data/geoip}"
EDITION="GeoLite2-City"
mkdir -p "$DEST_DIR"

url="https://download.maxmind.com/app/geoip_download?edition_id=${EDITION}&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${EDITION}..."
curl -fsSL "$url" -o "$tmp/db.tar.gz"

# The tarball contains GeoLite2-City_YYYYMMDD/GeoLite2-City.mmdb
tar -xzf "$tmp/db.tar.gz" -C "$tmp"
mmdb="$(find "$tmp" -name "${EDITION}.mmdb" | head -1)"
[ -n "$mmdb" ] || { echo "error: ${EDITION}.mmdb not found in archive" >&2; exit 1; }

cp "$mmdb" "$DEST_DIR/${EDITION}.mmdb"
echo "Installed $DEST_DIR/${EDITION}.mmdb ($(du -h "$DEST_DIR/${EDITION}.mmdb" | cut -f1))"
