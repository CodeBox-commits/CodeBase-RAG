// An empty base board with a few blocks in pencil outline: the model before anything is built.
export default function MiniCity({ className }: { className?: string }) {
  const blocks = [
    { x: 0, y: 0, h: 30 }, { x: 1, y: 0, h: 16 }, { x: 0, y: 1, h: 20 }, { x: 1, y: 1, h: 42 }, { x: 2, y: 0, h: 11 }, { x: 2, y: 1, h: 24 },
  ].sort((a, b) => a.x + a.y - (b.x + b.y))
  const iso = (x: number, y: number) => [(x - y) * 17, (x + y) * 9.5] as const
  const board = [iso(-0.7, -0.7), iso(3.1, -0.7), iso(3.1, 2.1), iso(-0.7, 2.1)].map(([a, b]) => `${a},${b}`).join(' ')
  return (
    <svg viewBox="-80 -64 160 120" className={className} aria-hidden>
      <polygon points={board} className="fill-sheet stroke-rule" strokeWidth="1" />
      {blocks.map((t, i) => {
        const [cx, cy] = iso(t.x, t.y)
        const w = 11, d = 6.2
        const top = `${cx},${cy - t.h - d} ${cx + w},${cy - t.h} ${cx},${cy - t.h + d} ${cx - w},${cy - t.h}`
        const left = `${cx - w},${cy - t.h} ${cx},${cy - t.h + d} ${cx},${cy + d} ${cx - w},${cy}`
        const right = `${cx + w},${cy - t.h} ${cx},${cy - t.h + d} ${cx},${cy + d} ${cx + w},${cy}`
        return (
          <g key={i} className="stroke-pencil/60" strokeWidth="0.8" strokeDasharray={i % 2 ? '2 2' : undefined}>
            <polygon points={left} className="fill-sheet-2" />
            <polygon points={right} className="fill-background" />
            <polygon points={top} className="fill-sheet" />
          </g>
        )
      })}
    </svg>
  )
}
