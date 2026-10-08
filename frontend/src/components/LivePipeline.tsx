import { AnimatePresence, motion } from 'motion/react'
import { ArrowDownUp, Binary, Check, ListTree, Network, PackagePlus, PenLine, Search, Signpost, Sparkles, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { GraphEdge, GraphNode, RetrievedHit, StepEvent, StepNode } from '../api'
import { citationsIn } from '../citations'
import { KIND_VAR } from '../palette'
import type { Message } from '../state'

// The pipeline played out above an answer while it is being made. Steps that finish within
// milliseconds of each other are revealed one after another, so each one can be seen.

type UiStep = StepNode | 'generate'
const ORDER: StepNode[] = ['query_planner', 'retrieval_router', 'embed_queries', 'retrieve', 'rerank', 'graph_search']
const ICON: Record<UiStep, LucideIcon> = {
  query_planner: Sparkles,
  retrieval_router: Signpost,
  embed_queries: Binary,
  retrieve: Search,
  rerank: ArrowDownUp,
  graph_search: Network,
  fetch_more: PackagePlus,
  generate: PenLine,
}
const NAME: Record<UiStep, string> = {
  query_planner: 'Plan',
  retrieval_router: 'Route',
  embed_queries: 'Embed',
  retrieve: 'Search',
  rerank: 'Rerank',
  graph_search: 'Graph',
  fetch_more: 'Ask for more',
  generate: 'Answer',
}

const REVEAL_MS = 420
const REVEAL_FAST_MS = 110

type Data = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** How many trace events are on screen: they catch up with the real trace one at a time. */
export function useRevealed(msg: Message) {
  const total = msg.trace?.length ?? 0
  const [shown, setShown] = useState(() => (msg.pending ? 0 : total))
  useEffect(() => {
    if (shown >= total) return
    const t = setTimeout(() => setShown((s) => s + 1), msg.content || !msg.pending ? REVEAL_FAST_MS : REVEAL_MS)
    return () => clearTimeout(t)
  }, [shown, total, msg.content, msg.pending])
  return Math.min(shown, total)
}

function trackFor(trace: StepEvent[]): UiStep[] {
  const asked = trace.some((e) => e.node === 'fetch_more')
  return [...ORDER, ...(asked ? (['fetch_more'] as const) : []), 'generate']
}

// --- the track: one node per step, packets running along the wire --------------------------

function Track({ track, done, active }: { track: UiStep[]; done: Set<UiStep>; active: UiStep | null }) {
  return (
    <div className="flex items-center" aria-hidden>
      {track.map((node, i) => {
        const Icon = ICON[node]
        const isDone = done.has(node)
        const isActive = node === active
        return (
          <div key={node} className={cn('flex items-center', i > 0 && 'flex-1')}>
            {i > 0 && (
              <span
                className={cn(
                  'mx-1 h-[2px] flex-1 rounded-full transition-colors duration-300',
                  isActive ? 'wire-live' : isDone ? 'wire-done' : 'bg-rule',
                )}
              />
            )}
            <span className="relative grid size-7 shrink-0 place-items-center">
              {isActive && (
                <>
                  <span className="absolute inset-0 animate-[ping-ring_1.2s_ease-out_infinite] rounded-full border border-thread" />
                  <span className="absolute -inset-0.5 animate-spin rounded-full bg-[conic-gradient(from_0deg,transparent_0deg,var(--thread)_300deg,transparent_360deg)] [animation-duration:0.9s]" />
                </>
              )}
              <motion.span
                initial={false}
                animate={{ scale: isActive ? 1.08 : 1 }}
                className={cn(
                  'relative grid size-7 place-items-center rounded-full border transition-colors duration-300',
                  isDone && 'border-thread bg-thread text-[#160936] shadow-[0_0_10px_rgb(177_140_255/0.6)]',
                  isActive && 'border-transparent bg-sheet-2 text-thread',
                  !isDone && !isActive && 'bg-sheet text-muted-foreground/60',
                )}
              >
                <Icon className="size-3.5" />
              </motion.span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

// --- one scene per step ------------------------------------------------------------------------

/** Planning: the question's words light up in a wave while a beam reads across them. */
function ReadingQuestion({ question }: { question: string }) {
  const words = question.split(/\s+/).filter(Boolean).slice(0, 40)
  return (
    <div className="relative overflow-hidden rounded-lg border bg-background/50 px-4 py-3.5">
      <p className="relative z-10 text-[1.02rem] font-medium leading-relaxed">
        {words.map((w, i) => (
          <span key={i} className="animate-[word-lit_1.6s_ease-in-out_infinite] text-pencil" style={{ animationDelay: `${i * 0.09}s` }}>
            {w}{' '}
          </span>
        ))}
      </p>
      <span className="pointer-events-none absolute inset-y-0 left-0 w-1/5 animate-[beam-x_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-thread/25 to-transparent" />
    </div>
  )
}

function Chip({ children, i, tone = 'thread' }: { children: string; i: number; tone?: 'thread' | 'method' }) {
  return (
    <motion.span
      initial={{ opacity: 0, y: 10, scale: 0.8 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: i * 0.06, type: 'spring', stiffness: 420, damping: 24 }}
      className={cn(
        'inline-block rounded-md border px-2 py-0.5 font-mono text-[0.76rem]',
        tone === 'thread' ? 'border-thread/60 bg-thread/15 text-thread shadow-[0_0_10px_rgb(177_140_255/0.3)]' : 'border-[var(--kind-method)]/50 bg-[var(--kind-method)]/10 text-[var(--kind-method)]',
      )}
    >
      {children}
    </motion.span>
  )
}

/** The plan: symbols it spotted and the searches it wrote, flying in. */
function PlanResult({ plan, route }: { plan: Data; route?: string }) {
  const symbols: string[] = plan.symbols ?? []
  const queries: string[] = plan.queries ?? []
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip i={0}>{String(plan.query_type ?? 'general').replaceAll('_', ' ')}</Chip>
        {symbols.map((s, i) => <Chip key={s} i={i + 1} tone="method">{s}</Chip>)}
      </div>
      <ul className="space-y-1">
        {queries.slice(0, 4).map((q, i) => (
          <motion.li
            key={q}
            initial={{ opacity: 0, x: -14 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.15 + i * 0.08 }}
            className="flex items-center gap-2 text-[0.86rem]"
          >
            <Search className="size-3 shrink-0 text-thread" /> <span className="truncate">{q}</span>
          </motion.li>
        ))}
      </ul>
      {route && (
        <div className="flex gap-1">
          {(['vector', 'hybrid', 'graph'] as const).map((r) => (
            <span key={r} className="relative flex-1 rounded-md border px-2 py-1 text-center text-[0.74rem] text-muted-foreground">
              {r === route && <motion.span layoutId="live-route" className="glow absolute inset-0 rounded-md bg-thread/20" />}
              <span className={cn('relative', r === route && 'text-thread')}>{r}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Embedding: each query as a row of bars, bouncing until its real vector arrives. */
function Vectors({ queries, previews }: { queries: string[]; previews?: number[][] }) {
  return (
    <div className="space-y-2">
      {queries.slice(0, 4).map((q, qi) => {
        const values = previews?.[qi]
        const max = values ? Math.max(...values.map(Math.abs), 1e-6) : 1
        return (
          <div key={q} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3">
            <span className="truncate text-[0.8rem] text-muted-foreground">{q}</span>
            <span className="flex h-6 items-end gap-[2px]">
              {Array.from({ length: 24 }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    'h-full flex-1 origin-bottom rounded-[1px] transition-transform duration-500',
                    !values && 'animate-[eq_0.7s_ease-in-out_infinite]',
                    values && values[i] < 0 ? 'bg-thread/70' : 'bg-[var(--kind-method)]/85',
                  )}
                  style={values ? { transform: `scaleY(${0.15 + (Math.abs(values[i]) / max) * 0.85})` } : { animationDelay: `${(i * 37 + qi * 91) % 700}ms` }}
                />
              ))}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Candidates: cascade in by search order, then re-sort into rerank order (the losers drop out). */
function Candidates({ results, reranked, shuffling }: { results: RetrievedHit[]; reranked?: RetrievedHit[]; shuffling: boolean }) {
  const key = (r: RetrievedHit) => `${r.filepath}:${r.symbol}:${r.start_line}`
  const list = (reranked ?? results).slice(0, 6)
  return (
    <ol className="relative space-y-1 overflow-hidden">
      <AnimatePresence initial={true}>
        {list.map((r, i) => (
          <motion.li
            key={key(r)}
            layout
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ delay: reranked ? 0 : i * 0.05, layout: { type: 'spring', stiffness: 260, damping: 26 } }}
            className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md border bg-background/50 px-2 py-1"
          >
            <span className="text-right text-[0.7rem] text-muted-foreground tabular-nums">{i + 1}</span>
            <span className="min-w-0 truncate font-mono text-[0.78rem]">
              {r.symbol} <span className="text-muted-foreground">{r.filepath}</span>
            </span>
            <span className="flex gap-1">
              {reranked && r.retrieval_rank != null && r.retrieval_rank !== i + 1 ? (
                <span className={cn('text-[0.68rem] tabular-nums', r.retrieval_rank > i + 1 ? 'text-verified' : 'text-check')}>
                  {r.retrieval_rank > i + 1 ? '▲' : '▼'}{Math.abs(r.retrieval_rank - (i + 1))}
                </span>
              ) : (
                (r.sources ?? []).map((s) => (
                  <span key={s} className={cn('rounded-sm px-1 text-[0.62rem] uppercase', s === 'vector' ? 'bg-[var(--kind-method)]/15 text-[var(--kind-method)]' : 'bg-highlight/15 text-highlight')}>
                    {s === 'vector' ? 'vec' : s}
                  </span>
                ))
              )}
            </span>
          </motion.li>
        ))}
      </AnimatePresence>
      {shuffling && (
        <span className="pointer-events-none absolute inset-x-0 top-0 h-1/4 animate-[beam-y_1.1s_linear_infinite] bg-gradient-to-b from-transparent via-thread/20 to-transparent" />
      )}
    </ol>
  )
}

/** Searching before results exist: a sweep over a field of index points. */
function Sweep() {
  const dots = useMemo(() => Array.from({ length: 70 }, (_, i) => ({ x: (i * 53) % 100, y: (i * 29) % 100, d: (i * 113) % 1400 })), [])
  return (
    <div className="relative h-28 overflow-hidden rounded-lg border bg-background/50">
      {dots.map((p, i) => (
        <span
          key={i}
          className="absolute size-1 animate-pulse rounded-full bg-[var(--kind-method)]"
          style={{ left: `${p.x}%`, top: `${p.y}%`, animationDelay: `${p.d}ms`, opacity: 0.5 }}
        />
      ))}
      <span className="absolute inset-y-0 left-0 w-1/4 animate-[beam-x_1.1s_linear_infinite] bg-gradient-to-r from-transparent via-thread/30 to-transparent" />
    </div>
  )
}

/** The graph walk: retrieved symbols in the middle, their neighbours bursting outwards. */
function Constellation({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const layout = useMemo(() => {
    const anchors = nodes.filter((n) => n.anchor).slice(0, 5)
    const rest = nodes.filter((n) => !n.anchor).slice(0, 22)
    const pos = new Map<string, { x: number; y: number }>()
    anchors.forEach((n, i) => {
      const a = (i / Math.max(anchors.length, 1)) * Math.PI * 2
      pos.set(n.id, { x: 100 + Math.cos(a) * (anchors.length > 1 ? 18 : 0), y: 60 + Math.sin(a) * (anchors.length > 1 ? 14 : 0) })
    })
    rest.forEach((n, i) => {
      const a = (i / Math.max(rest.length, 1)) * Math.PI * 2 + 0.3
      const r = 1 + (i % 2) * 0.28
      pos.set(n.id, { x: 100 + Math.cos(a) * 62 * r, y: 60 + Math.sin(a) * 36 * r })
    })
    const drawn = edges.filter((e) => pos.has(e.source) && pos.has(e.target)).slice(0, 40)
    return { anchors, rest, pos, drawn }
  }, [nodes, edges])
  return (
    <svg viewBox="0 0 200 120" className="h-28 w-full" aria-hidden>
      <g className="origin-center animate-spin [animation-duration:60s] [transform-box:fill-box]">
        {layout.drawn.map((e, i) => {
          const a = layout.pos.get(e.source)!, b = layout.pos.get(e.target)!
          return (
            <motion.line
              key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 0.7 }}
              transition={{ delay: 0.1 + i * 0.02, duration: 0.4 }}
              stroke={e.type === 'CALLS' ? 'var(--thread)' : e.type === 'INHERITS' ? 'var(--kind-class)' : 'var(--rule)'}
              strokeWidth={0.8}
            />
          )
        })}
        {[...layout.anchors, ...layout.rest].map((n, i) => {
          const p = layout.pos.get(n.id)!
          return (
            <motion.circle
              key={n.id}
              cx={p.x} cy={p.y}
              r={n.anchor ? 4.2 : 2.4}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: n.anchor ? 0 : 0.2 + i * 0.025, type: 'spring', stiffness: 380, damping: 18 }}
              fill={KIND_VAR[n.kind] ?? 'var(--thread)'}
              style={{ filter: `drop-shadow(0 0 ${n.anchor ? 4 : 2}px ${KIND_VAR[n.kind] ?? 'var(--thread)'})` }}
            />
          )
        })}
      </g>
    </svg>
  )
}

interface ContextItem { symbol: string; filepath: string; start_line: number; end_line?: number }

function cites(item: ContextItem, cited: { filepath: string; line: number }[]) {
  return cited.some((c) => (c.filepath === item.filepath || item.filepath.endsWith('/' + c.filepath)) && c.line >= item.start_line && c.line <= (item.end_line ?? item.start_line))
}

/** Writing: the code the model reads, a beam going down it, and each snippet lighting up when it's cited. */
function Reading({ context, content }: { context: ContextItem[]; content: string }) {
  const cited = useMemo(() => citationsIn(content), [content])
  const shown = context.slice(0, 6)
  return (
    <div className="relative overflow-hidden">
      <ul className="grid gap-1 sm:grid-cols-2">
        {shown.map((c, i) => {
          const lit = cites(c, cited)
          return (
            <motion.li
              key={`${c.filepath}:${c.start_line}:${c.symbol}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className={cn(
                'flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[0.74rem] transition-all duration-300',
                lit ? 'border-verified/70 bg-verified/10 text-verified shadow-[0_0_12px_rgb(163_238_127/0.35)]' : 'bg-background/50',
              )}
            >
              {lit ? <Check className="size-3 shrink-0" /> : <span className="size-1.5 shrink-0 rounded-full bg-thread/70" />}
              <span className="truncate">{c.symbol}</span>
              <span className={cn('ml-auto shrink-0', !lit && 'text-muted-foreground')}>:{c.start_line}</span>
            </motion.li>
          )
        })}
      </ul>
      {context.length > shown.length && <p className="mt-1.5 text-[0.72rem] text-muted-foreground">and {context.length - shown.length} more</p>}
      <span className="pointer-events-none absolute inset-x-0 top-0 h-1/3 animate-[beam-y_1.6s_linear_infinite] bg-gradient-to-b from-transparent via-thread/15 to-transparent" />
    </div>
  )
}

// --- putting it together ----------------------------------------------------------------------

function contextOf(events: Map<UiStep, StepEvent>): ContextItem[] {
  const base: ContextItem[] = events.get('graph_search')?.data.context
    ?? events.get('rerank')?.data.results
    ?? []
  const more: ContextItem[] = (events.get('fetch_more')?.data.items ?? []).flatMap((i: { found: ContextItem[] }) => i.found ?? [])
  return [...base, ...more]
}

function Scene({ active, events, question, content }: { active: UiStep; events: Map<UiStep, StepEvent>; question: string; content: string }) {
  const plan = events.get('query_planner')?.data
  const route = events.get('retrieval_router')?.data.strategy as string | undefined
  const embed = events.get('embed_queries')?.data
  const retrieved: RetrievedHit[] = events.get('retrieve')?.data.results ?? []
  const reranked: RetrievedHit[] | undefined = events.get('rerank')?.data.results
  const graph = events.get('graph_search')?.data

  let caption: string
  let body: React.ReactNode
  let key: string = active
  switch (active) {
    case 'query_planner':
      caption = 'Reading the question'
      body = <ReadingQuestion question={question} />
      break
    case 'retrieval_router':
    case 'embed_queries':
      if (active === 'embed_queries' && plan) {
        caption = 'Turning the searches into vectors'
        body = <Vectors queries={plan.queries ?? []} />
        key = 'vectors'
      } else {
        caption = plan ? `Planned ${(plan.queries ?? []).length} searches` : 'Choosing a route'
        body = plan ? <PlanResult plan={plan} route={route} /> : <ReadingQuestion question={question} />
        key = 'plan'
      }
      break
    case 'retrieve':
      caption = 'Searching vectors and keywords'
      body = embed ? (
        <div className="space-y-2">
          <Vectors queries={embed.queries ?? []} previews={embed.previews} />
          <Sweep />
        </div>
      ) : <Sweep />
      break
    case 'rerank':
    case 'graph_search':
      caption = active === 'rerank'
        ? `${retrieved.length} candidates found, reranking`
        : `Kept the best ${reranked?.length ?? 0}, walking the call graph`
      body = <Candidates results={retrieved} reranked={active === 'graph_search' ? reranked : undefined} shuffling={active === 'rerank'} />
      key = 'candidates'
      break
    case 'fetch_more':
      caption = 'The model asked for more code'
      body = <Sweep />
      break
    default: {
      const context = contextOf(events)
      const files = new Set(context.map((c) => c.filepath)).size
      caption = context.length ? `Reading ${context.length} snippets from ${files} ${files === 1 ? 'file' : 'files'}` : 'Writing the answer'
      body = (
        <div className="grid gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
          {graph?.nodes?.length ? <Constellation nodes={graph.nodes} edges={graph.edges ?? []} /> : null}
          <Reading context={context} content={content} />
        </div>
      )
    }
  }

  return (
    <div className="mt-3">
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={caption}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.16 }}
          className="mb-2.5 text-sm font-medium text-thread [text-shadow:0_0_14px_rgb(177_140_255/0.5)]"
          aria-live="polite"
        >
          {caption}…
        </motion.p>
      </AnimatePresence>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={key}
          initial={{ opacity: 0, x: 28, filter: 'blur(4px)' }}
          animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, x: -28, filter: 'blur(4px)' }}
          transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
        >
          {body}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/** Cited snippets popping up while the answer streams. */
function CitedSoFar({ content }: { content: string }) {
  const cited = useMemo(() => citationsIn(content), [content])
  if (!cited.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      <AnimatePresence>
        {cited.slice(-8).map((c) => (
          <motion.span
            key={c.text}
            layout
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 480, damping: 22 }}
            className="rounded-md border border-verified/50 bg-verified/10 px-1.5 py-px font-mono text-[0.7rem] text-verified"
          >
            {c.text}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  )
}

/** The message as far as it has been revealed, so the inspector moves in step with the scene. */
export function usePaced(msg: Message): Message {
  const shown = useRevealed(msg)
  const total = msg.trace?.length ?? 0
  return useMemo(
    () => (shown >= total ? msg : { ...msg, trace: msg.trace?.slice(0, shown), pending: true }),
    [msg, shown, total],
  )
}

export default function LivePipeline({ msg, question, onOpen }: { msg: Message; question: string; onOpen: () => void }) {
  const trace = useMemo(() => msg.trace ?? [], [msg.trace])
  const shown = useRevealed(msg)
  const revealed = trace.slice(0, shown)
  const events = new Map<UiStep, StepEvent>(revealed.map((e) => [e.node, e]))
  const track = trackFor(revealed)
  const done = new Set<UiStep>(revealed.map((e) => e.node))
  const caughtUp = shown >= trace.length
  if (!msg.pending && caughtUp && !msg.error) done.add('generate')
  const active: UiStep | null = msg.pending || !caughtUp ? track.find((n) => !done.has(n)) ?? 'generate' : null
  const writing = Boolean(msg.content) && caughtUp && msg.pending
  const staging = active !== null && !writing && !(msg.content && !msg.pending)

  const cited = msg.citations ?? []
  const backed = cited.filter((c) => c.status === 'verified' || c.status === 'graph').length

  return (
    <div className={cn('rounded-xl border transition-colors duration-500', staging ? 'glow mb-4 border-thread/40 bg-sheet/80 p-4' : 'mb-3 border-transparent')}>
      <div className="flex items-center gap-3">
        <div className={cn('min-w-0 transition-all duration-500', staging ? 'flex-1' : 'w-56 shrink-0 sm:w-72')}>
          <Track track={track} done={done} active={active} />
        </div>
        {!staging && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpen() }}
            className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ListTree className="size-3.5 shrink-0" />
            {writing
              ? 'Writing the answer…'
              : msg.pending
                ? `${NAME[active ?? 'generate']}…`
                : cited.length
                  ? `${backed} of ${cited.length} citations checked`
                  : 'How this was answered'}
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {staging && active && (
          <motion.div
            key="scene"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.2, 0.7, 0.2, 1] }}
            className="overflow-hidden"
          >
            <Scene active={active} events={events} question={question} content={msg.content} />
          </motion.div>
        )}
      </AnimatePresence>
      {writing && <CitedSoFar content={msg.content} />}
    </div>
  )
}
