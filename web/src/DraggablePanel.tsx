// A floating panel with a drag-handle title bar and collapse (▾/▸) toggle.
// Drag offset and collapsed state persist per id in localStorage. The panel
// keeps its CSS anchor (from `className`); dragging applies a translate offset.

import { useRef, useState, type ReactNode } from 'react';

const num = (k: string, d: number) => {
  const v = localStorage.getItem(k);
  return v != null && !Number.isNaN(Number(v)) ? Number(v) : d;
};

export function DraggablePanel({
  id,
  className,
  title,
  extra,
  maxBody,
  children,
}: {
  id: string;
  className: string;
  title: string;
  extra?: ReactNode;
  maxBody?: string;
  children: ReactNode;
}) {
  const [dx, setDx] = useState(() => num(`panel.${id}.dx`, 0));
  const [dy, setDy] = useState(() => num(`panel.${id}.dy`, 0));
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(`panel.${id}.col`) === '1');
  const start = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);

  const onDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // buttons aren't drag handles
    start.current = { x: e.clientX, y: e.clientY, dx, dy };
    const move = (ev: MouseEvent) => {
      const s = start.current!;
      setDx(s.dx + ev.clientX - s.x);
      setDy(s.dy + ev.clientY - s.y);
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const s = start.current!;
      localStorage.setItem(`panel.${id}.dx`, String(s.dx + ev.clientX - s.x));
      localStorage.setItem(`panel.${id}.dy`, String(s.dy + ev.clientY - s.y));
      start.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    e.preventDefault();
  };

  const toggle = () =>
    setCollapsed((c) => {
      localStorage.setItem(`panel.${id}.col`, c ? '0' : '1');
      return !c;
    });

  return (
    <div className={`panel float ${className}`} style={{ transform: `translate(${dx}px, ${dy}px)` }}>
      <div className="panel-bar" onMouseDown={onDown}>
        <span className="pb-title">{title}</span>
        <span className="pb-actions">
          {extra}
          <button className="pb-btn" onClick={toggle} title={collapsed ? 'expand' : 'collapse'}>
            {collapsed ? '▸' : '▾'}
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="panel-body" style={maxBody ? { maxHeight: maxBody, overflowY: 'auto' } : undefined}>
          {children}
        </div>
      )}
    </div>
  );
}
