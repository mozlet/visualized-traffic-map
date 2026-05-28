// Project COLOR STANDARD — single source of truth for every traffic colour.
// Full rationale in docs/COLOR-STANDARD.md. Rules enforced here:
//  1. RED (ANOMALY) is reserved for alerts/anomalies (DDoS) ONLY — no normal
//     class may be red, so a red arc always means "something is wrong".
//  2. Normal classes use luminous, colourblind-aware hues; the salient set is
//     kept small (rare protocols share muted slate).
//  3. Encoding: width = volume, animation = direction, alpha = recency.
//  4. Light theme darkens arc colours so they read on a pale background.

import type { LiveFlow, ProtoKey } from './types';

export type RGB = [number, number, number];

// Reserved — alert/anomaly only.
export const ANOMALY: RGB = [239, 68, 68];

// Protocol palette. `esp` (IPsec) was red and collided with ANOMALY → indigo now.
// Rare control protocols collapse to muted slate to keep the salient set ≤7.
export const PROTO_COLOR: Record<ProtoKey, RGB> = {
  tcp: [34, 211, 238], // cyan — bulk traffic
  udp: [245, 158, 11], // amber
  icmp: [232, 121, 249], // magenta
  icmp6: [217, 70, 239], // violet
  igmp: [74, 222, 128], // green (multicast)
  gre: [45, 212, 191], // teal (tunnel)
  esp: [129, 140, 248], // indigo (IPsec VPN) — moved off red
  sctp: [96, 165, 250], // blue
  ospf: [148, 163, 184], // slate (routing/control)
  other: [148, 163, 184], // slate
};

// SNI application categories → colour, grouped into a few hue FAMILIES (social=green,
// media=magenta, web=blue, infra=slate, system=gold, commerce=teal/orange, news=pink).
// `video` was red and collided with ANOMALY → magenta family now.
export const CATEGORY_COLOR: Record<string, RGB> = {
  chat: [34, 197, 94], // social — green
  social: [22, 163, 74],
  video: [217, 70, 239], // media — magenta (NOT red)
  media: [192, 38, 211],
  search: [59, 130, 246], // web — blue
  browser: [14, 165, 233],
  cloud: [148, 163, 184], // infra — slate
  cdn: [100, 116, 139],
  dns: [129, 140, 248], // indigo (resolution)
  os: [234, 179, 8], // system — gold
  'os-update': [202, 138, 4],
  shopping: [249, 115, 22], // commerce — orange
  finance: [20, 184, 166], // teal
  news: [236, 72, 153], // pink
  dev: [161, 161, 170], // neutral
};

// Classified but uncategorised.
export const APP_OTHER: RGB = [203, 213, 225];

// Light-theme arcs: darken so luminous hues stay legible on a pale background.
const darken = (c: RGB): RGB => [Math.round(c[0] * 0.58), Math.round(c[1] * 0.58), Math.round(c[2] * 0.58)];

// The colour for a flow under the active encoding (anomaly > category > protocol).
export function flowColor(f: LiveFlow, byCat: boolean, light = false): RGB {
  let c: RGB;
  if (f.ddos) c = ANOMALY;
  else if (byCat && f.flow.app) c = CATEGORY_COLOR[f.flow.category ?? ''] ?? APP_OTHER;
  else c = PROTO_COLOR[f.proto];
  return light ? darken(c) : c;
}

export const hex = (c: RGB): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// Parse a "#rrggbb" string → RGB; null on malformed input. Used to render each
// submarine cable in TeleGeography's own colour (cables.geojson `color`).
export function parseHex(s: string | undefined): RGB | null {
  if (!s || s[0] !== '#' || s.length !== 7) return null;
  const n = parseInt(s.slice(1), 16);
  return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
