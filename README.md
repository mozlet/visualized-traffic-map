# visualized-traffic-map

A real-time, self-hosted visualization of your network's traffic on an
interactive world map — built for an [OPNsense](https://opnsense.org/) gateway,
but fed by any NetFlow v9 exporter or OPNsense `flowd` log.

Flows are geolocated and animated as comet trails between source and
destination, snapped onto real submarine-cable routes for trans-oceanic hops,
classified by application (from passively-sniffed TLS SNI), and continuously
self-corrected using real `mtr`-measured paths. Everything renders from bundled
local map data — **no third-party tiles or CDNs**, so the IPs you are analyzing
never leak to an outside service.

## Features

- **Live flow map** — animated arcs (deck.gl), 2D map or 3D globe, pan/zoom.
- **Real routing geometry** — trans-oceanic hops snap to bundled submarine
  cables; inland traffic egresses via a coastal gateway and follows a land
  corridor instead of cutting across the sea; great-circle densified so paths
  curve naturally and never seam across the antimeridian.
- **Real measured paths** — `mtr` traceroutes to busy destinations, geolocated
  per hop.
- **Self-correcting geolocation** — aggregates observed flow geo into a
  canonical table; relocates IPs whose MaxMind coordinate is physically
  impossible given measured RTT (speed-of-light bound), with a full audit trail.
- **Application classification** — passively sniffs TLS ClientHello SNI (stock
  `tcpdump` over ssh, parsed locally), maps domains to apps via a data-driven
  longest-suffix rule table, and surfaces top apps + unclassified SNIs.
- **Traffic feature filters** — by IP protocol (TCP/UDP/ICMP/ICMPv6/IGMP/GRE/
  ESP/SCTP/OSPF), by service port (HTTPS/QUIC/HTTP/DNS/SSH), and a DDoS overlay
  (data-driven fan-in detection).
- **Scrubbable timeline** — bottom throughput histogram with time ticks; drag to
  brush a window and replay it.
- **Inspect & stats** — hover any flow for details; live throughput gauge
  (duration-weighted, de-duplicated, window follows the refresh rate), top
  countries / destinations / sources / ports / apps.
- **Day/night terminator**, **draggable + collapsible panels**, **i18n**
  (English default, 中文 toggle), localized place labels that follow traffic.

## Architecture

```
OPNsense pflow → samplicate → telegraf NetFlow ┐
OPNsense flowd.log ──ssh tail───────────────────┴→ ingestor (geo enrich)
   → Redis (hot: stream + pub/sub) + PostgreSQL/TimescaleDB (cold: flows)
   → axum + WebSocket API → React + deck.gl frontend
side: geo-doctor (self-correction) · mtr-worker (measured paths) · sni-sniff (SNI)
```

| crate | role |
|-------|------|
| `flowd-parse` | OPNsense flowd store-v1 binary parser |
| `ingestor` | stdin (flowd binary or telegraf JSON) → geo enrich → Redis + PG |
| `geoip` | IP → lat/lon (MaxMind GeoLite2); private → home |
| `api` | axum + WebSocket; serves flows, stats, timeline, routes, apps; static host |
| `geo-doctor` | self-correcting geolocation + RTT-physics relocation + audit |
| `mtr-worker` | `mtr` to top destinations, per-hop geolocation |
| `sni-sniff` | pcap stream → TLS ClientHello SNI → app classification |

Frontend: TypeScript + React + Vite + deck.gl, with bundled GeoJSON basemaps.

## Quick start

```bash
# 1. Dependencies (PostgreSQL/TimescaleDB + Redis), listening on 127.0.0.1
docker compose up -d        # or: podman compose up -d
for m in migrations/*.sql; do psql "$DATABASE_URL" -f "$m"; done

# 2. Configure
cp .env.example .env        # set HOME_LAT/HOME_LON, GEOIP_DB_PATH, ssh host, …

# 3. Frontend
cd web && npm install && npm run build

# 4. Run (dev)
cargo run --release -p api                       # http://127.0.0.1:8088
./scripts/run-live.sh        # flowd ingest   (or run-telegraf-live.sh for NetFlow)
./scripts/run-sni.sh         # SNI sniffer (optional)
```

Production deploy as systemd units under `/opt`: `./deploy/install.sh`.

### Configuration (`.env`)

`HOME_LAT` / `HOME_LON` (your gateway's location), `DATABASE_URL`, `REDIS_URL`,
`GEOIP_DB_PATH` (path to a `GeoLite2-City.mmdb`), `OPNSENSE_SSH_HOST`,
`SNI_IFACE(S)`. See `.env.example`. Secrets stay in `.env` (gitignored).

## Data sources & attribution

- Country/place basemap: **[Natural Earth](https://www.naturalearthdata.com/)**
  (public domain).
- Submarine cables: **[TeleGeography Submarine Cable Map](https://www.submarinecablemap.com/)**
  — verify their terms before redistribution.
- IP geolocation: **MaxMind GeoLite2** — *“This product includes GeoLite2 data
  created by MaxMind, available from [maxmind.com](https://www.maxmind.com).”*
  The `.mmdb` files are **not** bundled; supply your own.

## License

MIT. See [LICENSE](LICENSE).
