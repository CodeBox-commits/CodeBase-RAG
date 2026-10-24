import { Check, Search } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { KIND_VAR } from '../palette'
import {
  CANDIDATES, CONTEXT_SUMMARY, FETCHED, GRAPH_EDGES, GRAPH_NODES, KEEP, NEED, PLAN, QUESTION, RERANKED, ROUTE, ROUTE_REASON, ROUTES, VECTORS,
} from './sampleStory'
import { easeInOut, lerp, revealed, segment } from './story'

// One scene per pipeline step, each drawn entirely from t (0..1): how far through the step the reader
// has scrolled. Same t, same frame, so scrolling back plays the step in reverse.

/** Shown once `on`: fades and rises into place. */
const appear = (on: boolean, extra?: CSSProperties): CSSProperties => ({
  opacity: on ? 1 : 0,
  transform: on ? 'none' : 'translateY(8px)',
  transition: 'opacity 220ms ease, transform 220ms ease',
  ...extra,
})

function Chip({ children, tone = 'thread', on }: { children: string; tone?: 'thread' | 'method'; on: boolean }) {
  return (
    <span
      style={appear(on)}
      className={cn(
        'inline-block rounded-md border px-2 py-0.5 font-mono text-[0.76rem]',
        tone === 'thread' ? 'border-thread/45 bg-thread/10 text-thread' : 'border-[var(--kind-method)]/50 bg-[var(--kind-method)]/10 text-[var(--kind-method)]',
      )}
    >
      {children}
    </span>
  )
}

/** Plan: the question is read word by word, then its type, symbols and search queries come out. */
export function Plan({ t }: { t: number }) {
  const words = QUESTION.split(' ')
  const lit = revealed(segment(t, 0, 0.4), words.length)
  const items = 1 + PLAN.symbols.length + PLAN.queries.length
  const shown = revealed(segment(t, 0.4, 1), items)
  return (
    <div className="space-y-5">
      <p className="text-[1.15rem] font-medium leading-relaxed">
        {words.map((w, i) => (
          <span key={i} className={cn('transition-colors duration-200', i < lit ? 'text-foreground' : 'text-pencil/45')}>{w} </span>
        ))}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip on={shown > 0}>{PLAN.type}</Chip>
        {PLAN.symbols.map((s, i) => <Chip key={s} tone="method" on={shown > 1 + i}>{s}</Chip>)}
      </div>
      <ul className="space-y-1.5">
        {PLAN.queries.map((q, i) => (
          <li key={q} style={appear(shown > 1 + PLAN.symbols.length + i)} className="flex items-center gap-2 text-[0.9rem]">
            <Search className="size-3.5 shrink-0 text-pencil" /> {q}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Route: the marker slides from vector to the route the question needs, then says why. */
export function Route({ t }: { t: number }) {
  const target = ROUTES.indexOf(ROUTE)
  const at = lerp(0, target, easeInOut(segment(t, 0.15, 0.6)))
  return (
    <div className="space-y-5">
      <div className="relative grid grid-cols-3 gap-2">
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-md border border-thread/50 bg-thread/10"
          style={{ width: 'calc((100% - 1rem) / 3)', transform: `translateX(calc(${at} * (100% + 0.5rem)))` }}
        />
        {ROUTES.map((r, i) => (
          <span key={r} className={cn('relative rounded-md border px-3 py-3 text-center text-sm', Math.round(at) === i ? 'text-thread' : 'text-muted-foreground')}>
            {r}
          </span>
        ))}
      </div>
      <p style={appear(t > 0.65)} className="max-w-[52ch] text-[0.92rem] leading-relaxed text-muted-foreground">{ROUTE_REASON}</p>
      <div style={appear(t > 0.8)} className="flex gap-2 text-xs text-muted-foreground">
        <span className="rounded-md border px-2 py-1">BM25 on</span>
        <span className="rounded-md border px-2 py-1">graph: 1 hop</span>
      </div>
    </div>
  )
}

/** Embed: each query grows its bars, the first numbers of its vector. */
export function Embed({ t }: { t: number }) {
  return (
    <div className="space-y-4">
      {PLAN.queries.map((q, qi) => {
        const values = VECTORS[qi]
        const max = Math.max(...values.map(Math.abs))
        return (
          <div key={q} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-center gap-4">
            <span className="truncate text-[0.85rem] text-muted-foreground">{q}</span>
            <span className="flex h-9 items-end gap-[3px]">
              {values.map((v, i) => {
                const start = qi * 0.15 + i * 0.012
                const grow = segment(t, start, start + 0.35)
                return (
                  <span
                    key={i}
                    className={cn('h-full flex-1 origin-bottom rounded-[1px]', v < 0 ? 'bg-thread/70' : 'bg-[var(--kind-method)]/85')}
                    style={{ transform: `scaleY(${Math.max(0.04, grow * (0.15 + (Math.abs(v) / max) * 0.85))})` }}
                  />
                )
              })}
            </span>
          </div>
        )
      })}
      <p style={appear(t > 0.85)} className="text-xs text-muted-foreground">384 numbers per query, computed locally. These are the first 24.</p>
    </div>
  )
}

function SourceTag({ s }: { s: 'vector' | 'bm25' }) {
  return (
    <span className={cn('rounded-sm px-1 text-[0.6rem] uppercase', s === 'vector' ? 'bg-[var(--kind-method)]/15 text-[var(--kind-method)]' : 'bg-highlight/15 text-highlight')}>
      {s === 'vector' ? 'vec' : s}
    </span>
  )
}

/** Search: the 24 candidates arrive in rank order, tagged by which search found them. */
export function SearchScene({ t }: { t: number }) {
  const shown = revealed(segment(t, 0, 0.9), CANDIDATES.length)
  return (
    <ol className="grid grid-flow-col grid-cols-2 grid-rows-12 gap-x-4 gap-y-1">
      {CANDIDATES.map((c, i) => (
        <li key={c.symbol} style={appear(i < shown)} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 text-[0.76rem]">
          <span className="text-right text-muted-foreground tabular-nums">{i + 1}</span>
          <span className="truncate font-mono">{c.symbol}</span>
          <span className="flex gap-1">{c.sources.map((s) => <SourceTag key={s} s={s} />)}</span>
        </li>
      ))}
    </ol>
  )
}

const ROW = 34
/** Space opened below the kept eight for the cut line. */
const CUT_GAP = 22

/** Rerank: the top ten slide into the cross-encoder's order; the cut keeps eight. */
export function Rerank({ t }: { t: number }) {
  const move = easeInOut(segment(t, 0.1, 0.7))
  const settled = t > 0.75
  return (
    <div className="relative" style={{ height: RERANKED.length * ROW + CUT_GAP }}>
      {RERANKED.map((from, to) => {
        const c = CANDIDATES[from]
        const kept = to < KEEP
        const delta = from - to
        return (
          <div
            key={c.symbol}
            className={cn(
              'absolute inset-x-0 grid h-[30px] grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md border bg-background/60 px-2.5 text-[0.8rem] transition-opacity duration-300',
              settled && !kept && 'opacity-35',
            )}
            style={{ transform: `translateY(${lerp(from, to, move) * ROW + (to >= KEEP ? CUT_GAP * move : 0)}px)` }}
          >
            <span className="text-right text-xs text-muted-foreground tabular-nums">{settled ? to + 1 : from + 1}</span>
            <span className="truncate font-mono">{c.symbol} <span className="text-muted-foreground">{c.file}</span></span>
            <span style={appear(settled && delta !== 0)} className={cn('text-[0.7rem] tabular-nums', delta > 0 ? 'text-verified' : 'text-check')}>
              {delta > 0 ? '▲' : '▼'}{Math.abs(delta)}
            </span>
          </div>
        )
      })}
      <div style={appear(settled, { top: KEEP * ROW + (CUT_GAP - 16) / 2 - 2 })} className="absolute inset-x-0 flex items-center gap-2 text-[0.7rem] text-muted-foreground">
        <span className="h-px flex-1 border-t border-dashed border-pencil/50" /> kept 8 <span className="h-px flex-1 border-t border-dashed border-pencil/50" />
      </div>
    </div>
  )
}

/** Walk the graph: lines draw out from the top hits to their callers, callees and bases. */
export function Graph({ t }: { t: number }) {
  const pos = new Map(GRAPH_NODES.map((n) => [n.id, n]))
  const draw = segment(t, 0.1, 0.75)
  return (
    <div>
      <svg viewBox="0 0 320 200" className="h-[17rem] w-full" aria-hidden>
        {GRAPH_EDGES.map((e, i) => {
          const a = pos.get(e.from)!, b = pos.get(e.to)!
          const d = segment(draw, i * 0.05, i * 0.05 + 0.45)
          return (
            <line
              key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              pathLength={1}
              strokeDasharray="1"
              strokeDashoffset={1 - d}
              stroke={e.type === 'CALLS' ? 'var(--thread)' : 'var(--kind-class)'}
              strokeOpacity={0.75}
              strokeWidth={1}
            />
          )
        })}
        {GRAPH_NODES.map((n, i) => {
          const s = n.anchor ? 1 : segment(draw, 0.1 + i * 0.04, 0.3 + i * 0.04)
          return (
            <g key={n.id} transform={`translate(${n.x} ${n.y}) scale(${s})`}>
              <circle r={n.anchor ? 6 : 4} fill={KIND_VAR[n.kind]} style={{ filter: `drop-shadow(0 0 ${n.anchor ? 5 : 2}px ${KIND_VAR[n.kind]})` }} />
              <text y={n.y >= 120 ? (n.anchor ? 15 : 13) : n.anchor ? -10 : -8} textAnchor="middle" className="fill-pencil font-mono text-[7px]" style={{ opacity: t > 0.7 ? 1 : 0, transition: 'opacity 250ms' }}>
                {n.id}
              </text>
            </g>
          )
        })}
      </svg>
      <p style={appear(t > 0.8)} className="flex gap-4 text-xs text-muted-foreground">
        <span><span className="mr-1.5 inline-block h-px w-4 translate-y-[-3px] bg-thread" />calls</span>
        <span><span className="mr-1.5 inline-block h-px w-4 translate-y-[-3px] bg-[var(--kind-class)]" />inherits</span>
        <span>9 symbols added that search alone missed</span>
      </p>
    </div>
  )
}

/** Ask for more: the model names what it's missing, and an exact lookup adds it. */
export function AskMore({ t }: { t: number }) {
  const typed = revealed(segment(t, 0, 0.35), NEED.length)
  const found = t > 0.45
  const added = t > 0.65
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-background/60 px-4 py-3">
        <p className="mb-1.5 text-xs text-muted-foreground">The model, before answering</p>
        <p className="font-mono text-[0.95rem]">
          {NEED.slice(0, typed)}
          {typed < NEED.length && <span className="ml-0.5 inline-block h-[1em] w-[0.5ch] translate-y-[0.15em] bg-thread" />}
        </p>
      </div>
      <div
        style={appear(found)}
        className={cn(
          'flex items-center gap-2.5 rounded-lg border px-4 py-3 text-[0.9rem] transition-colors duration-300',
          added ? 'border-verified/50 text-verified' : 'text-foreground',
        )}
      >
        {added ? <Check className="size-4 shrink-0" /> : <Search className="size-4 shrink-0 text-pencil" />}
        <span>Exact lookup found <span className="font-mono">{FETCHED.symbol}</span></span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{FETCHED.file}:{FETCHED.line}</span>
      </div>
      <p style={appear(t > 0.8)} className="text-sm text-muted-foreground">{CONTEXT_SUMMARY}. Keep scrolling to see the answer.</p>
    </div>
  )
}
