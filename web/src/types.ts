export interface Geo {
  lat: number;
  lon: number;
  country: string | null;
  city: string | null;
  is_home: boolean;
}

// Enriched flow as published by the API over /ws and /api/recent.
export interface Flow {
  src_addr: string;
  dst_addr: string;
  src_port?: number | null;
  dst_port?: number | null;
  protocol?: number | null;
  octets?: number | null;
  packets?: number | null;
  recv_sec?: number | null;
  flow_start?: number | null; // exporter clock (ms); finish-start = real active span
  flow_finish?: number | null;
  src_geo?: Geo | null;
  dst_geo?: Geo | null;
  app?: string | null; // SNI-derived application (ip_app), stamped by the API
  category?: string | null;
  service?: string | null; // well-known port→service (nmap table), stamped by the ingestor
}

// A flow held in the live buffer, tagged with arrival time for fade-out.
export interface LiveFlow {
  flow: Flow;
  born: number; // performance.now() when received
  src: [number, number];
  dst: [number, number];
  path: [number, number][]; // mtr-real / cable-snapped / great-circle (sphere-safe)
  snapped: boolean; // true when routed along a submarine cable
  real: boolean; // true when path is a real mtr-measured route
  ddos: boolean; // true when dst is being flooded by many sources
  proto: ProtoKey;
  svc: ServiceKey;
  width: number;
}

export type ProtoKey =
  | 'tcp'
  | 'udp'
  | 'icmp'
  | 'icmp6'
  | 'igmp'
  | 'gre'
  | 'esp'
  | 'sctp'
  | 'ospf'
  | 'other';

// Coarse service derived from the well-known port on either end.
export type ServiceKey = 'https' | 'quic' | 'http' | 'dns' | 'ssh' | 'svc';

export interface HomeConfig {
  lat: number;
  lon: number;
}
