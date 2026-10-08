import { AnimatePresence, motion } from 'motion/react'
import { ArrowDown, ArrowUp, Check, ChevronDown, Minus, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import type { ExpandedHit, GraphEdge, GraphNode, RetrievedHit, StepEvent, StepNode } from '../api'
import { KIND_VAR } from '../palette'
import type { Message } from '../state'
import ForceGraph3D from './ForceGraph3D'
import MiniCity from './MiniCity'

type UiStep = StepNode | 'generate'
const STEPS: { node: UiStep; label: string; sub: string }[] = [
  { node: 'query_planner', label: 'Plan', sub: 'What kind of question this is, which symbols it names, and what to search for.' },
  { node: 'retrieval_router', label: 'Choose a route', sub: 'How much to lean on keyword search and on the call graph.' },
  { node: 'embed_queries', label: 'Embed the queries', sub: 'Each search query becomes a vector (cached, so repeats are free).' },
  { node: 'retrieve', label: 'Search', sub: 'Vector search and BM25 run side by side and are merged by rank.' },
  { node: 'rerank', label: 'Rerank', sub: 'A local cross-encoder reads each candidate next to the question.' },
  { node: 'graph_search', label: 'Walk the graph', sub: 'Callers, callees and overrides, and the code they point to.' },
  { node: 'fetch_more', label: 'Ask for more', sub: 'The model named code it was missing; it was fetched before answering.' },
  { node: 'generate', label: 'Answer and check', sub: 'Written from that context only; every citation checked against it.' },
]

type StepState = 'pending' | 'active' | 'done' | 'failed'

// "Ask for more" only appears when the model actually asked.
function stepsFor(msg: Message) {
  const ran = (msg.trace ?? []).some((e) => e.node === 'fetch_more')
  return STEPS.filter((s) => s.node !== 'fetch_more' || ran)
}

function stepStates(msg: Message): Record<UiStep, StepState> {
  const seen = new Set((msg.trace ?? []).map((e) => e.node))
  const out = {} as Record<UiStep, StepState>
  let activeGiven = false
  stepsFor(msg).forEach(({ node }) => {
    let s: StepState
    if (node === 'generate') s = !msg.pending && msg.content ? (msg.error ? 'failed' : 'done') : 'pending'
    else if (seen.has(node)) s = 'done'
    else if (!msg.pending && msg.error) s = 'failed'
    else s = 'pending'
    if (s === 'pending' && msg.pending && !activeGiven) {
      s = 'active'
      activeGiven = true
    }
    out[node] = s
  })
  return out
}

// --- small parts ------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-baseline gap-3 py-1 text-[0.8rem]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function Tokens({ items, mono = true }: { items: string[]; mono?: boolean }) {
  if (!items.length) return <span className="text-muted-foreground">none</span>
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((t, i) => (
        <span key={t + i} className={cn('rounded-[4px] border bg-background/60 px-1.5 py-px text-[0.74rem]', mono && 'font-mono')}>{t}</span>
      ))}
    </span>
  )
}

function Hit({ rank, symbol, location, children }: { rank: ReactNode; symbol: string; location: string; children?: ReactNode }) {
  const i = typeof rank === 'number' ? rank - 1 : 0
  return (
    <motion.li
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(i, 12) * 0.035, duration: 0.22 }}
      className="grid grid-cols-[1.5rem_1fr] gap-2 py-1.5"
    >
      <span className="pt-0.5 text-right text-[0.72rem] text-muted-foreground tabular-nums">{rank}</span>
      <div className="min-w-0">
        <div className="truncate font-mono text-[0.78rem] font-medium">{symbol}</div>
        <div className="truncate font-mono text-[0.7rem] text-muted-foreground">{location}</div>
        {children}
      </div>
    </motion.li>
  )
}

function Bar({ value, className }: { value: number; className?: string }) {
  return (
    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-rule-soft" aria-hidden>
      <motion.span
        className={cn('block h-full rounded-full bg-pencil/70', className)}
        initial={{ width: 0 }}
        animate={{ width: `${Math.max(3, Math.min(1, value) * 100)}%` }}
        transition={{ duration: 0.5, ease: [0.2, 0.7, 0.2, 1] }}
      />
    </span>
  )
}

// --- one panel per step ------------------------------------------------------------------

type Data = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function PlanPanel({ data }: { data: Data }) {
  return (
    <dl>
      <Row label="Question type"><span className="capitalize">{String(data.query_type ?? '').replaceAll('_', ' ')}</span>, {data.complexity}</Row>
      <Row label="Symbols named"><Tokens items={data.symbols ?? []} /></Row>
      <Row label="Searching for">
        <ol className="space-y-1">
          {(data.queries ?? []).map((q: string) => <li key={q} className="leading-snug">{q}</li>)}
        </ol>
      </Row>
    </dl>
  )
}

const ROUTES: Record<string, string> = {
  vector: 'A question about one symbol: semantic search plus an exact name lookup, then one step through the graph.',
  hybrid: 'A question about relationships or structure: full keyword search alongside vectors, then three steps through the graph.',
  graph: 'A question about call flow or impact: retrieval anchors a deep walk of the call graph.',
}

function RoutePanel({ strategy }: { strategy: string }) {
  return (
    <div>
      <div className="flex gap-1" role="img" aria-label={`Route: ${strategy}`}>
        {(['vector', 'hybrid', 'graph'] as const).map((r) => (
          <span
            key={r}
            className={cn(
              'flex-1 rounded-md border px-2 py-1 text-center text-[0.76rem]',
              r === strategy ? 'glow border-thread bg-thread/15 text-thread' : 'text-muted-foreground',
            )}
          >
            {r}
          </span>
        ))}
      </div>
      <p className="mt-2 text-[0.8rem] leading-snug text-muted-foreground">{ROUTES[strategy]}</p>
    </div>
  )
}

/** The first dimensions of a query vector as a bar code: what "turning text into numbers" looks like. */
function Fingerprint({ values }: { values: number[] }) {
  const max = Math.max(...values.map(Math.abs), 1e-6)
  return (
    <span className="mt-1.5 flex h-6 items-center gap-px" aria-hidden>
      {values.map((v, i) => (
        <span key={i} className="flex h-full flex-1 flex-col justify-center">
          <span
            className={cn('w-full rounded-[1px]', v >= 0 ? 'self-end bg-[var(--kind-method)]/80' : 'bg-thread/50')}
            style={{ height: `${8 + (Math.abs(v) / max) * 42}%`, marginTop: v >= 0 ? 'auto' : undefined }}
          />
        </span>
      ))}
    </span>
  )
}

function EmbedPanel({ data }: { data: Data }) {
  const previews: number[][] = data.previews ?? []
  return (
    <div className="space-y-3">
      <p className="text-[0.8rem] text-muted-foreground">
        {previews.length} {previews.length === 1 ? 'vector' : 'vectors'} of {data.dimensions} numbers each. The bars are the first 24.
      </p>
      {(data.queries ?? []).map((q: string, i: number) => (
        <div key={q}>
          <p className="text-[0.8rem] leading-snug">{q}</p>
          {previews[i] && <Fingerprint values={previews[i]} />}
        </div>
      ))}
    </div>
  )
}

function RetrievePanel({ data }: { data: Data }) {
  const results: RetrievedHit[] = data.results ?? []
  const terms: string[] = data.lexical_terms ?? []
  return (
    <div>
      <dl>
        <Row label="Vector lists">{data.vector_lists ?? 0}, one per query</Row>
        <Row label="Keyword terms"><Tokens items={terms} /></Row>
        <Row label="Merged">by rank (reciprocal rank fusion, k = 60) into {results.length} candidates</Row>
      </dl>
      {results.length === 0 && <p className="mt-2 text-[0.8rem] text-muted-foreground">Nothing scored above the similarity threshold.</p>}
      <ol className="mt-2 divide-y divide-rule-soft">
        {results.map((r, i) => (
          <Hit key={`${r.filepath}:${r.symbol}:${r.start_line}`} rank={i + 1} symbol={r.symbol} location={`${r.filepath}:${r.start_line}`}>
            <Bar value={r.score ?? 0} />
            <p className="mt-1 text-[0.7rem] text-muted-foreground">
              Found by {r.sources.join(' and ')}
              {r.vector_score != null && `, similarity ${r.vector_score.toFixed(2)}`}
              {r.bm25_score != null && `, BM25 ${r.bm25_score.toFixed(1)}`}
            </p>
          </Hit>
        ))}
      </ol>
    </div>
  )
}

function RerankPanel({ data }: { data: Data }) {
  const results: RetrievedHit[] = data.results ?? []
  return (
    <div>
      <p className="text-[0.8rem] text-muted-foreground">
        Kept {data.kept} of {data.candidates}, using <span className="font-mono">{data.model ?? 'no reranker'}</span>.
      </p>
      {!data.applied && <p className="mt-1.5 text-[0.8rem] text-check">Not applied{data.error ? `: ${data.error}` : ''}. The search order was kept.</p>}
      <ol className="mt-2 divide-y divide-rule-soft">
        {results.map((r, i) => {
          const moved = (r.retrieval_rank ?? i + 1) - (i + 1)
          return (
            <Hit key={`${r.filepath}:${r.symbol}:${r.start_line}`} rank={i + 1} symbol={r.symbol} location={`${r.filepath}:${r.start_line}`}>
              <span className="mt-1 flex items-center gap-1 text-[0.7rem] text-muted-foreground">
                {moved > 0 ? <ArrowUp className="size-3 text-verified" /> : moved < 0 ? <ArrowDown className="size-3 text-check" /> : <Minus className="size-3" />}
                {moved === 0 ? 'Same place as in search' : `${moved > 0 ? 'Up' : 'Down'} ${Math.abs(moved)} from #${r.retrieval_rank}`}
              </span>
            </Hit>
          )
        })}
      </ol>
      {data.applied && (
        <p className="mt-2 text-[0.72rem] text-muted-foreground">
          Final score: {data.weight} of the cross-encoder's plus {(1 - data.weight).toFixed(2)} of the search score.
        </p>
      )}
    </div>
  )
}

/** Callers on the left, what was retrieved in the middle, what it calls on the right. */
function CallTree({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const layout = useMemo(() => {
    const anchors = nodes.filter((n) => n.anchor).slice(0, 6)
    const anchorIds = new Set(anchors.map((a) => a.id))
    const left: string[] = []
    const right: string[] = []
    edges.forEach((e) => {
      if (anchorIds.has(e.target) && !anchorIds.has(e.source) && !left.includes(e.source)) left.push(e.source)
      if (anchorIds.has(e.source) && !anchorIds.has(e.target) && !right.includes(e.target)) right.push(e.target)
    })
    const cols = [left.slice(0, 10), anchors.map((a) => a.id), right.slice(0, 10)]
    const H = Math.max(...cols.map((c) => c.length), 1) * 32 + 28
    const pos = new Map<string, { x: number; y: number }>()
    const xs = [80, 290, 500]
    cols.forEach((col, ci) => col.forEach((id, i) => pos.set(id, { x: xs[ci], y: 22 + ((i + 0.5) * (H - 28)) / col.length })))
    const kind = new Map(nodes.map((n) => [n.id, n.kind]))
    const drawn = edges.filter((e) => pos.has(e.source) && pos.has(e.target))
    return { cols, pos, H, kind, drawn }
  }, [nodes, edges])

  const short = (id: string) => {
    const name = id.split('::').pop() ?? id
    return name.length > 20 ? '…' + name.slice(-19) : name
  }
  return (
    <svg viewBox={`0 0 580 ${layout.H}`} className="w-full" role="img" aria-label="Callers, retrieved symbols and what they call">
      {[['callers', 80], ['retrieved', 290], ['calls and members', 500]].map(([t, x]) => (
        <text key={t} x={x} y="10" textAnchor="middle" className="fill-muted-foreground text-[10px]">{t}</text>
      ))}
      {layout.drawn.map((e, i) => {
        const a = layout.pos.get(e.source)!, b = layout.pos.get(e.target)!
        const mx = (a.x + b.x) / 2
        return (
          <path
            key={i}
            d={`M${a.x + 70} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x - 70} ${b.y}`}
            fill="none"
            strokeWidth={e.type === 'CALLS' ? 1.4 : 1}
            strokeDasharray={e.type === 'CALLS' ? undefined : '3 3'}
            className={e.type === 'CALLS' ? 'stroke-thread' : 'stroke-pencil/60'}
          />
        )
      })}
      {layout.cols.flatMap((col, ci) => col.map((id) => {
        const p = layout.pos.get(id)!
        return (
          <g key={id + ci}>
            <rect
              x={p.x - 70} y={p.y - 11} width="140" height="22" rx="4"
              className={ci === 1 ? 'stroke-graphite' : 'stroke-rule'}
              strokeWidth={ci === 1 ? 1.4 : 1}
              fill={KIND_VAR[layout.kind.get(id) ?? ''] ?? 'var(--sheet)'}
            />
            <text x={p.x} y={p.y + 3.5} textAnchor="middle" className="fill-[#1d2128] font-mono text-[10px]"><title>{id}</title>{short(id)}</text>
          </g>
        )
      }))}
    </svg>
  )
}

function GraphPanel({ data }: { data: Data }) {
  const [mode, setMode] = useState<'tree' | '3d'>('tree')
  const nodes: GraphNode[] = data.nodes ?? []
  const edges: GraphEdge[] = data.edges ?? []
  const expanded: ExpandedHit[] = data.expanded ?? []
  const impact: { name: string; total: number; truncated: boolean; depth: number; files: { filepath: string; count: number }[] }[] = data.impact ?? []
  if (!nodes.length && !expanded.length && !impact.length) {
    return <p className="text-[0.8rem] text-muted-foreground">No calls, bases or overrides were found for these symbols.</p>
  }
  return (
    <div className="space-y-4">
      {nodes.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[0.8rem] text-muted-foreground">
              {nodes.length} symbols and {edges.length} links{data.depth ? `, up to ${data.depth} ${data.depth > 1 ? 'steps' : 'step'} away` : ''}
            </p>
            <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as 'tree' | '3d')}>
              <ToggleGroupItem value="tree" className="h-7 px-2.5 text-xs">Tree</ToggleGroupItem>
              <ToggleGroupItem value="3d" className="h-7 px-2.5 text-xs">3D</ToggleGroupItem>
            </ToggleGroup>
          </div>
          {mode === 'tree'
            ? <CallTree nodes={nodes} edges={edges} />
            : <ForceGraph3D nodes={nodes} edges={edges} className="h-64 rounded-md border bg-background/50" />}
        </div>
      )}
      {impact.map((r) => (
        <div key={r.name}>
          <p className="text-[0.8rem]">
            Changing <span className="font-mono">{r.name}</span> can affect <strong>{r.total}{r.truncated ? '+' : ''}</strong> symbols in{' '}
            <strong>{r.files.length}</strong> files, up to {r.depth} steps away.
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {r.files.slice(0, 6).map((f) => (
              <li key={f.filepath} className="flex justify-between gap-3 font-mono text-[0.72rem] text-muted-foreground">
                <span className="truncate">{f.filepath}</span><span className="tabular-nums">{f.count}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {expanded.length > 0 && (
        <div>
          <p className="text-[0.8rem] font-medium">Code added from the graph</p>
          <ol className="mt-1 divide-y divide-rule-soft">
            {expanded.map((r) => (
              <Hit key={`${r.filepath}:${r.symbol}:${r.start_line}`} rank="+" symbol={r.symbol} location={`${r.filepath}:${r.start_line}`}>
                <p className="mt-0.5 text-[0.7rem] text-muted-foreground">{r.reason}</p>
              </Hit>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

function FetchMorePanel({ data }: { data: Data }) {
  const items: { item: string; found: { symbol: string; filepath: string; start_line: number }[] }[] = data.items ?? []
  return (
    <div className="space-y-3">
      {items.map(({ item, found }) => (
        <div key={item}>
          <p className="text-[0.8rem]">Asked for <span className="font-mono">{item}</span></p>
          {found.length ? (
            <ol className="divide-y divide-rule-soft">
              {found.map((f) => <Hit key={`${f.filepath}:${f.symbol}`} rank="+" symbol={f.symbol} location={`${f.filepath}:${f.start_line}`} />)}
            </ol>
          ) : (
            <p className="text-[0.76rem] text-muted-foreground">Nothing new: it was already in the context, or isn't in the index.</p>
          )}
        </div>
      ))}
    </div>
  )
}

function StepBody({ node, event, msg }: { node: UiStep; event?: StepEvent; msg: Message }) {
  if (node === 'generate') {
    if (msg.pending) return null
    const cites = msg.citations ?? []
    const ok = cites.filter((c) => c.status === 'verified' || c.status === 'graph').length
    return (
      <p className="text-[0.8rem] text-muted-foreground">
        {cites.length ? `${ok} of ${cites.length} citations backed by the context.` : 'No citations to check.'}
      </p>
    )
  }
  if (!event) return null
  if (node === 'query_planner') return <PlanPanel data={event.data} />
  if (node === 'retrieval_router') return <RoutePanel strategy={event.data.strategy} />
  if (node === 'embed_queries') return <EmbedPanel data={event.data} />
  if (node === 'retrieve') return <RetrievePanel data={event.data} />
  if (node === 'rerank') return <RerankPanel data={event.data} />
  if (node === 'graph_search') return <GraphPanel data={event.data} />
  if (node === 'fetch_more') return <FetchMorePanel data={event.data} />
  return null
}

function StepMarker({ state, n }: { state: StepState; n: number }) {
  return (
    <span className="relative z-10 grid size-6 shrink-0 place-items-center">
      {state === 'active' && (
        <span aria-hidden className="absolute -inset-[3px] animate-spin rounded-full bg-[conic-gradient(from_0deg,transparent_0deg,var(--thread)_300deg,transparent_360deg)] [animation-duration:0.9s]" />
      )}
    <span
      className={cn(
        'relative z-10 grid size-6 shrink-0 place-items-center rounded-full border text-[0.72rem] font-semibold tabular-nums',
        state === 'done' && 'border-thread bg-thread text-[#160936]',
        state === 'active' && 'border-transparent bg-sheet-2 text-thread',
        state === 'failed' && 'border-check bg-check text-white',
        state === 'pending' && 'bg-sheet text-muted-foreground',
      )}
    >
      {state === 'done' ? <Check className="size-3.5" /> : state === 'failed' ? <X className="size-3.5" /> : n}
    </span>
    </span>
  )
}

// Keeps the running step in view as the pipeline moves down the panel.
const scrollIntoView = (el: HTMLLIElement | null) => el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

export default function PipelineInspector({ msg, question }: { msg: Message | null; question?: string }) {
  const [closed, setClosed] = useState<Set<UiStep>>(new Set())
  useEffect(() => setClosed(new Set()), [msg?.id]) // eslint-disable-line react-hooks/set-state-in-effect

  if (!msg) {
    return (
      <div className="grid h-full place-items-center px-6 py-16 text-center">
        <div>
          <MiniCity className="mx-auto h-24 w-32" />
          <p className="mt-4 max-w-[30ch] text-sm text-muted-foreground">Ask a question and each step it goes through appears here as it runs.</p>
        </div>
      </div>
    )
  }
  const steps = stepsFor(msg)
  const states = stepStates(msg)
  const events = new Map((msg.trace ?? []).map((e) => [e.node, e]))
  const errors = (msg.trace ?? []).at(-1)?.errors ?? []

  return (
    <div className="p-4">
      {question && <p className="mb-4 border-l-2 border-rule pl-3 text-sm leading-snug text-muted-foreground">{question}</p>}
      <ol className="relative">
        {/* The rail joining the steps. */}
        <span aria-hidden className="absolute bottom-3 left-3 top-3 w-px bg-rule" />
        {steps.map((s, i) => {
          const st = states[s.node]
          const open = st === 'done' && !closed.has(s.node)
          return (
            <li key={s.node} ref={st === 'active' ? scrollIntoView : undefined} className="relative flex gap-3 pb-4 last:pb-0">
              {i < steps.length - 1 && (
                <motion.span
                  aria-hidden
                  className="absolute bottom-0 left-3 top-6 w-px origin-top bg-thread shadow-[0_0_8px_var(--thread)]"
                  initial={false}
                  animate={{ scaleY: st === 'done' ? 1 : 0 }}
                  transition={{ duration: 0.35, ease: [0.2, 0.7, 0.2, 1] }}
                />
              )}
              <StepMarker state={st} n={i + 1} />
              <div className="min-w-0 flex-1 pt-0.5">
                <button
                  className="flex w-full items-center gap-2 rounded-sm text-left disabled:cursor-default"
                  disabled={st !== 'done'}
                  aria-expanded={st === 'done' ? open : undefined}
                  onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(s.node)) n.delete(s.node); else n.add(s.node); return n })}
                >
                  <span className={cn('text-sm font-semibold', st === 'pending' && 'text-muted-foreground')}>{s.label}</span>
                  {st === 'active' && <span className="animate-pulse text-xs text-thread">running</span>}
                  {st === 'done' && <ChevronDown className={cn('ml-auto size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />}
                </button>
                <p className="mt-0.5 text-[0.76rem] leading-snug text-muted-foreground">{s.sub}</p>
                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: [0.2, 0.7, 0.2, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="mt-2.5 rounded-lg border bg-background/50 p-3">
                        <StepBody node={s.node} event={events.get(s.node as StepNode)} msg={msg} />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </li>
          )
        })}
      </ol>
      {errors.length > 0 && (
        <details className="mt-4 rounded-lg border border-check/30 p-3 text-[0.78rem]">
          <summary className="cursor-pointer text-check">{errors.length} {errors.length === 1 ? 'step' : 'steps'} reported a problem</summary>
          <ul className="mt-2 space-y-1">{errors.map((e) => <li key={e} className="break-words font-mono text-[0.72rem] text-muted-foreground">{e}</li>)}</ul>
        </details>
      )}
    </div>
  )
}
