// A small isometric block of towers for empty states: the code city, before anything is built.

const TOWERS = [
  { x: 0, y: 0, h: 34, c: 'var(--kind-method)' },
  { x: 1, y: 0, h: 18, c: 'var(--kind-function)' },
  { x: 0, y: 1, h: 22, c: 'var(--kind-class)' },
  { x: 1, y: 1, h: 46, c: 'var(--thread)' },
  { x: 2, y: 0, h: 12, c: 'var(--kind-method)' },
  { x: 2, y: 1, h: 26, c: 'var(--kind-function)' },
]

export default function MiniCity({ className }: { className?: string }) {
  // Painter's order: back rows first.
  const order = [...TOWERS].sort((a, b) => a.x + a.y - (b.x + b.y))
  return (
    <svg viewBox="-60 -70 120 120" className={className} style={{ filter: 'drop-shadow(0 0 10px rgb(177 140 255 / 0.35))' }} aria-hidden>
      {order.map((t, i) => {
        const cx = (t.x - t.y) * 16
        const cy = (t.x + t.y) * 9
        const w = 11, d = 6.5
        const top = `${cx},${cy - t.h - d} ${cx + w},${cy - t.h} ${cx},${cy - t.h + d} ${cx - w},${cy - t.h}`
        const left = `${cx - w},${cy - t.h} ${cx},${cy - t.h + d} ${cx},${cy + d} ${cx - w},${cy}`
        const right = `${cx + w},${cy - t.h} ${cx},${cy - t.h + d} ${cx},${cy + d} ${cx + w},${cy}`
        return (
          <g key={i} style={{ color: t.c }}>
            <polygon points={left} fill="currentColor" opacity="0.55" />
            <polygon points={right} fill="currentColor" opacity="0.8" />
            <polygon points={top} fill="currentColor" />
          </g>
        )
      })}
    </svg>
  )
}
