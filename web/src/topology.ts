// Optional regional-network overlay loaded from /data/topology.json. The
// repository ships an empty default and topology.example.json as a template:
// users drop a topology.json in place if they want their country's BGP POPs,
// trunk lines, and backbone corridor hubs to surface in the routing/render
// layers. Without it the app stays globally generic — submarine cables, mtr
// paths, and a country/state basemap, but no opinionated per-country bones.

export interface POPNode {
  position: [number, number];
  name: string;
  country?: string;
}

export interface PMTilesUrls {
  /** Mid tier: a regional vector basemap (~10-100 MB). Empty = unavailable. */
  local?: string;
  /** Large tier: a country / continent vector basemap (~0.5-3 GB). */
  country?: string;
}

export interface Topology {
  /** Visible backbone POPs (rendered by infra.ts as sky-400 dots + label). */
  pops: POPNode[];
  /** Trunk segments between POP names (pairs reference `pops[].name`). */
  trunks: [string, string][];
  /**
   * Synthetic landRoute stepping-stones for a regional corridor where the
   * PeeringDB facility set thins out — keeps Dijkstra on a real overland
   * chain instead of jumping across an intervening bay or sea.
   */
  corridorHubs: [number, number][];
  /** Index pairs into corridorHubs that must be wired as graph edges. */
  corridorEdges: [number, number][];
  /** Vector basemap (PMTiles) URLs per detail tier. Either may be empty. */
  pmtiles: PMTilesUrls;
}

const EMPTY: Topology = { pops: [], trunks: [], corridorHubs: [], corridorEdges: [], pmtiles: {} };
let topology: Topology = EMPTY;
let loaded = false;

export async function loadTopology(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const r = await fetch('/data/topology.json');
    if (!r.ok) return;
    const j = await r.json();
    topology = {
      pops: Array.isArray(j.pops) ? j.pops : [],
      trunks: Array.isArray(j.trunks) ? j.trunks : [],
      corridorHubs: Array.isArray(j.corridorHubs) ? j.corridorHubs : [],
      corridorEdges: Array.isArray(j.corridorEdges) ? j.corridorEdges : [],
      pmtiles: j.pmtiles && typeof j.pmtiles === 'object' ? {
        local: typeof j.pmtiles.local === 'string' ? j.pmtiles.local : undefined,
        country: typeof j.pmtiles.country === 'string' ? j.pmtiles.country : undefined,
      } : {},
    };
  } catch {
    // No topology.json: stay generic; cables + mtr + basemap still render.
  }
}

export function getTopology(): Topology {
  return topology;
}
