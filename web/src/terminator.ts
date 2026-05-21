// Day/night terminator overlay (like Fortinet/Kaspersky maps). Shades the night
// hemisphere and draws the solar terminator. Pure astronomy — no data, no CDN.
// Per-longitude terminator-latitude method (à la Leaflet.Terminator).

import { PolygonLayer, PathLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// Approximate solar declination (deg) and subsolar longitude (deg) for `date`.
function sun(date: Date): { decl: number; subLon: number } {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - start) / 86400000;
  const decl = -23.44 * Math.cos(D2R * (360 / 365) * (dayOfYear + 10));
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const subLon = -15 * (utcHours - 12); // sun overhead at this longitude
  return { decl, subLon };
}

// Closed ring of the night hemisphere: terminator curve + the dark pole cap.
function nightRing(date: Date): [number, number][] {
  const { decl, subLon } = sun(date);
  const tanDecl = Math.tan(decl * D2R);
  const ring: [number, number][] = [];
  for (let lng = -180; lng <= 180; lng += 1) {
    const ha = (lng - subLon) * D2R; // hour angle of this meridian
    const lat = Math.atan(-Math.cos(ha) / tanDecl) * R2D;
    ring.push([lng, lat]);
  }
  const pole = decl > 0 ? -90 : 90; // antisolar (dark) pole
  ring.push([180, pole], [-180, pole]);
  return ring;
}

export function terminatorLayers(date: Date): Layer[] {
  const ring = nightRing(date);
  return [
    new PolygonLayer<{ polygon: [number, number][] }>({
      id: 'night',
      data: [{ polygon: ring }],
      getPolygon: (d) => d.polygon,
      getFillColor: [3, 6, 20, 96], // dim the night side
      getLineColor: [0, 0, 0, 0],
      stroked: false,
      filled: true,
      pickable: false,
      // night spans the whole world; let it tile with the repeating map
      wrapLongitude: true,
    }),
    new PathLayer<{ path: [number, number][] }>({
      id: 'terminator-line',
      data: [{ path: ring.slice(0, 361) }], // just the terminator curve
      getPath: (d) => d.path,
      getColor: [148, 163, 184, 90],
      getWidth: 1,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      pickable: false,
    }),
  ];
}
