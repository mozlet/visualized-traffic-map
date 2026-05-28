# Traffic-Map Color Standard

A color standard for live network-traffic / threat maps. We surveyed the
established public maps — **Kaspersky Cyberthreat Map**, **Cloudflare Radar**,
**Digital Attack Map** (Arbor/Google), **Check Point** and **Radware** live maps —
plus categorical-palette guidance (ColorBrewer). They share conventions but none
publish a reusable spec, so we codify one here. The single source of truth in code
is [`web/src/colors.ts`](../web/src/colors.ts); this document is the rationale.

## What the surveyed maps have in common

- **Near-black background**, so luminous arcs glow and read at a glance.
- **Animated arcs** cross the globe; motion encodes direction, light encodes life.
- **Red = danger.** Across all of them red/orange means attack, threat, or
  high-severity — never "normal traffic".
- **Categorical color** encodes one dimension (attack type / protocol / app), kept
  to a **small, distinguishable set** (~5–7 salient hues; ColorBrewer caps
  colorblind-safe qualitative palettes at ~7).
- **Thickness = volume**, and brightness/opacity tracks recency or intensity.

## The standard

### 1. Background & luminance
Dark navy base (`#0b1120` 2-D, `#05070f` 3-D). Arcs are luminous, additive in feel.
Light theme exists for daytime use; arc colors are **darkened ~42%** there so they
stay legible on a pale background (`flowColor(..., light=true)`).

### 2. RED is reserved
`ANOMALY = rgb(239,68,68)` is used **only** for alerts/anomalies (currently the
DDoS fan-in detector). No normal protocol or category may be red, so a red arc
*always* means "something is wrong". This fixed two prior collisions: `esp`
(IPsec) and the `video` category were both red.

### 3. Protocol palette (default encoding) — ≤7 salient hues
| Proto | Color | Hue |
|---|---|---|
| tcp | `#22d3ee` | cyan (bulk) |
| udp | `#f59e0b` | amber |
| icmp | `#e879f9` | magenta |
| icmp6 | `#d946ef` | violet |
| igmp | `#4ade80` | green (multicast) |
| gre | `#2dd4bf` | teal (tunnel) |
| esp | `#818cf8` | indigo (IPsec VPN) |
| sctp | `#60a5fa` | blue |
| ospf / other | `#94a3b8` | slate (control/rare) |

Rare control protocols collapse toward muted slate so the eye-catching set stays
small. tcp/udp/icmp carry most traffic and stay the most distinct.

### 4. Category palette (color-by-app) — hue families
Grouped so related categories share a family and the legend reads as ~7 colors:
- **social** (chat, social) — green
- **media** (video, media) — magenta
- **web** (search, browser) — blue
- **infra** (cloud, cdn, dns) — slate / indigo
- **system** (os, os-update) — gold
- **commerce** (shopping=orange, finance=teal)
- **news** — pink

Sub-categories vary by lightness within the family. Red stays reserved for any
future "threat/malware" category.

### 5. Encoding rules (non-color channels)
- **Width** = bytes (log-scaled). **Animation** = real flow direction.
- **Opacity** = recency (endpoints fade out as flows age).
- **Severity** uses a green→amber→red ramp **only** on the anomaly axis — never to
  distinguish normal classes.

## Applying it
- `web/src/colors.ts` — `PROTO_COLOR`, `CATEGORY_COLOR`, `ANOMALY`, `APP_OTHER`,
  `flowColor(flow, byCat, light)`, `hex()`.
- `web/src/layers.ts` consumes `flowColor`; re-exports the palettes for the legend.
- `web/src/App.css` `.cat-*` bar classes mirror `CATEGORY_COLOR`.
- Legend/swatches in `App.tsx` import the palette from `layers.ts` (one place).
