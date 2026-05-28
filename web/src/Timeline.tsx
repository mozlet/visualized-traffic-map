// Scrubbable bottom timeline (like Digital Attack Map / Cloudflare Radar):
// per-bucket throughput bars with time ticks + peak scale; click-drag to brush
// a window and replay it.

import { useEffect, useRef, useState } from 'react';

interface Pt {
  t: number; // epoch seconds
  bps: number;
}

function fmtBps(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + 'G';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + 'M';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + 'K';
  return String(b);
}

// Tick label format adapts to the total span + the time settings.
function fmtTick(t: number, windowS: number, timeLocal: boolean, hour12: boolean): string {
  const d = new Date(t * 1000);
  const tz = timeLocal ? undefined : 'UTC';
  if (windowS <= 180)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12, timeZone: tz });
  if (windowS <= 2 * 86400)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12, timeZone: tz });
  if (windowS <= 30 * 86400)
    return d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12, timeZone: tz });
  return d.toLocaleDateString([], { month: '2-digit', day: '2-digit', timeZone: tz });
}

export function Timeline({
  windowS,
  label,
  timeLocal,
  hour12,
  onBrush,
}: {
  windowS: number;
  label: string;
  timeLocal: boolean;
  hour12: boolean;
  onBrush: (fromS: number, toS: number) => void;
}) {
  const [pts, setPts] = useState<Pt[]>([]);
  const [sel, setSel] = useState<[number, number] | null>(null); // fractions 0..1
  const [hover, setHover] = useState<number | null>(null); // fraction under cursor
  const dragRef = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const load = () =>
      fetch(`/api/timeline?since_s=${windowS}&buckets=120`)
        .then((r) => r.json())
        .then((d) => setPts(d.points ?? []))
        .catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [windowS]);

  const n = Math.max(1, pts.length);
  const max = Math.max(1, ...pts.map((p) => p.bps));
  const frac = (e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const tAt = (f: number) => (pts.length ? pts[Math.min(pts.length - 1, Math.floor(f * pts.length))].t : 0);

  const bucketS = windowS / n;
  const down = (e: React.MouseEvent) => {
    const f = frac(e);
    dragRef.current = f;
    setSel([f, f]);
  };
  const move = (e: React.MouseEvent) => {
    const f = frac(e);
    if (dragRef.current != null) {
      setSel([dragRef.current, f]);
      return;
    }
    setHover(f);
  };
  const up = (e: React.MouseEvent) => {
    if (dragRef.current == null) return;
    const f = frac(e);
    const a = Math.min(dragRef.current, f);
    const b = Math.max(dragRef.current, f);
    dragRef.current = null;
    if (!pts.length) return setSel(null);
    if (b - a > 0.01) {
      // drag → replay the brushed window
      setSel([a, b]);
      onBrush(tAt(a), tAt(b) + bucketS);
      return;
    }
    // single click → seek: replay a window centred on the clicked bucket
    const t = tAt(f);
    const win = Math.max(windowS / 12, bucketS * 3);
    const half = win / 2 / windowS; // window half-width as a 0..1 fraction
    setSel([f - half, f + half]);
    onBrush(t - win / 2, t + win / 2 + bucketS);
  };
  const leave = (e: React.MouseEvent) => {
    setHover(null);
    if (dragRef.current != null) up(e);
  };
  const hp = hover != null && pts.length ? pts[Math.min(pts.length - 1, Math.floor(hover * pts.length))] : null;

  const ticks = pts.length
    ? [0, 0.25, 0.5, 0.75, 1].map((f) => ({
        f,
        t: pts[Math.min(pts.length - 1, Math.round(f * (pts.length - 1)))].t,
      }))
    : [];

  return (
    <div className="panel timeline">
      <div className="tl-head">
        <span>{label}</span>
        <span className="tl-peak">↥ {fmtBps(max)}bps</span>
      </div>
      {hp && (
        <div className="tl-tip" style={{ left: `${Math.min(0.98, Math.max(0.02, hover ?? 0)) * 100}%` }}>
          {fmtTick(hp.t, windowS, timeLocal, hour12)} · {fmtBps(hp.bps)}bps
        </div>
      )}
      <svg
        ref={svgRef}
        preserveAspectRatio="none"
        viewBox={`0 0 ${n} 100`}
        onMouseDown={down}
        onMouseMove={move}
        onMouseUp={up}
        onMouseLeave={leave}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} className="tl-grid" x1={g * n} y1={0} x2={g * n} y2={100} vectorEffect="non-scaling-stroke" />
        ))}
        {pts.map((p, i) => {
          const h = Math.max(1, (Math.log10(p.bps + 1) / Math.log10(max + 1)) * 100);
          return <rect key={i} className="tl-bar" x={i} y={100 - h} width={1.05} height={h} />;
        })}
        {sel && (
          <rect
            className="tl-sel"
            x={Math.min(sel[0], sel[1]) * n}
            y={0}
            width={Math.abs(sel[1] - sel[0]) * n}
            height={100}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {hover != null && (
          <line className="tl-cursor" x1={hover * n} y1={0} x2={hover * n} y2={100} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="tl-axis">
        {ticks.map((tk, i) => (
          <span key={i}>{fmtTick(tk.t, windowS, timeLocal, hour12)}</span>
        ))}
      </div>
    </div>
  );
}
