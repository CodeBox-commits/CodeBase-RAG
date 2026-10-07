import { useEffect, useMemo, useState } from 'react'
import type { ExpandedHit, GraphEdge, GraphNode, RetrievedHit, StepEvent, StepNode } from '../api'
import type { Message } from '../state'
import ForceGraph3D, { EDGE_COLORS, KIND_COLORS } from './ForceGraph3D'
import MiniCity from './MiniCity'

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`

type UiStep = StepNode | 'generate'
const STEPS: { node: UiStep; label: string; sub: string }[] = [
  { node: 'query_planner', label: 'Plan query', sub: 'LLM classifies intent, extracts symbols, writes search queries' },
  { node: 'retrieval_router', label: 'Route', sub: 'Chooses vector, hybrid or graph-heavy retrieval' },
  { node: 'embed_queries', label: 'Embed queries', sub: 'Turns each search query into a vector, cached in Redis' },
  { node: 'retrieve', label: 'Search & fuse', sub: 'Qdrant vector lists + RediSearch BM25 → Reciprocal Rank Fusion' },
  { node: 'rerank', label: 'Rerank', sub: 'Local cross-encoder (MiniLM-L-12) rescores each candidate against the question' },
  { node: 'graph_search', label: 'Traverse graph', sub: 'Neo4j: callers, callees, overrides; pulls in the code they point to' },
  { node: 'fetch_more', label: 'Ask for more', sub: 'The model named code it was missing; it was fetched before answering' },
  { node: 'generate', label: 'Generate answer', sub: 'Grounded answer with file:line citations' },
]

type StepState = 'pending' | 'active' | 'done' | 'failed'

// "Ask for more" only appears when the model actually asked.
function stepsFor(msg: Message) {
  const ran = (msg.trace ?? []).some((e) => e.node === 'fetch_more')
  return STEPS.filter((s) => s.node !== 'fetch_more' || ran)
}

function stepStates(msg: Message): Record<UiStep, StepState> {
  const trace = msg.trace ?? []
  const seen = new Map(trace.map((e) => [e.node, e]))
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

// ---------------------------------------------------------------------------

function Chips({ items, className = '' }: { items: string[]; className?: string }) {
  if (!items.length) return <span className="muted small">none</span>
  return (
    <div className="chips-row">
      {items.map((t, i) => <span key={t + i} className={`tchip ${className}`} style={{ animationDelay: `${i * 60}ms` }}>{t}</span>)}
    </div>
  )
}

function PlanPanel({ data }: { data: Record<string, any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (
    <div className="step-panel">
      <div className="kv"><span>Intent</span><b className="intent">{String(data.query_type).replace('_', ' ')}</b></div>
      <div className="kv"><span>Complexity</span><b>{data.complexity}</b></div>
      <div className="kv col"><span>Symbols</span><Chips items={data.symbols ?? []} className="sym" /></div>
      <div className="kv col">
        <span>Search queries</span>
        <ol className="query-list">
          {(data.queries ?? []).map((q: string, i: number) => (
            <li key={q} style={{ animationDelay: `${i * 120}ms` }}><span className="mono">q{i}</span>{q}</li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function RoutePanel({ strategy }: { strategy: string }) {
  const branches = ['vector', 'hybrid', 'graph']
  const ys = [26, 70, 114]
  return (
    <div className="step-panel">
      <svg viewBox="0 0 320 140" className="route-svg" role="img" aria-label={`Strategy: ${strategy}`}>
        <circle cx="30" cy="70" r="9" className="route-root" />
        {branches.map((b, i) => {
          const on = b === strategy
          return (
            <g key={b} className={on ? 'on' : ''}>
              <path d={`M39 70 C 110 70, 110 ${ys[i]}, 180 ${ys[i]}`} className="route-path" />
              <rect x="186" y={ys[i] - 13} width="110" height="26" rx="13" className="route-pill" />
              <text x="241" y={ys[i] + 4} textAnchor="middle" className="route-text">{b}</text>
            </g>
          )
        })}
      </svg>
      <p className="muted small">
        {strategy === 'vector' && 'Symbol or implementation question: semantic search plus exact symbol lookup, then a 1-hop graph walk.'}
        {strategy === 'hybrid' && 'Relationship or architecture question: full BM25 + vectors, then a 3-hop graph walk.'}
        {strategy === 'graph' && 'Call-flow question: retrieval anchors a deep walk of the call graph.'}
      </p>
    </div>
  )
}

function Fingerprint({ values, delay }: { values: number[]; delay: number }) {
  const max = Math.max(...values.map(Math.abs), 1e-6)
  return (
    <div className="fingerprint" aria-hidden>
      {values.map((v, i) => (
        <span
          key={i}
          className={v >= 0 ? 'pos' : 'neg'}
          style={{ height: `${10 + (Math.abs(v) / max) * 90}%`, animationDelay: `${delay + i * 18}ms` }}
        />
      ))}
    </div>
  )
}

function EmbedPanel({ data }: { data: Record<string, any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const previews: number[][] = data.previews ?? []
  return (
    <div className="step-panel">
      <div className="kv"><span>Vectors</span><b>{previews.length} × {data.dimensions}-d</b></div>
      {(data.queries ?? []).map((q: string, i: number) => (
        <div key={q} className="embed-row">
          <span className="embed-q"><span className="mono">q{i}</span>{q}</span>
          {previews[i] && <Fingerprint values={previews[i]} delay={i * 150} />}
        </div>
      ))}
      <p className="muted tiny">First 24 of {data.dimensions} dimensions shown.</p>
    </div>
  )
}

function RetrievePanel({ data }: { data: Record<string, any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const results: RetrievedHit[] = data.results ?? []
  const lists: number = data.vector_lists ?? 0
  const terms: string[] = data.lexical_terms ?? []
  return (
    <div className="step-panel">
      <div className="fusion-diagram">
        <div className="fusion-sources">
          {Array.from({ length: lists }, (_, i) => (
            <span key={i} className="src vec" style={{ animationDelay: `${i * 100}ms` }}>Qdrant · q{i}</span>
          ))}
          {terms.length > 0 && (
            <span className="src bm25" style={{ animationDelay: `${lists * 100}ms` }}>
              BM25 · {(data.lexical_fields ?? []).join('|')}
            </span>
          )}
        </div>
        <div className="fusion-arrow" aria-hidden><span /></div>
        <div className="fusion-sink">RRF<small>k = 60</small></div>
      </div>
      {terms.length > 0 && <div className="kv col"><span>BM25 terms</span><Chips items={terms} /></div>}
      <div className="kv col">
        <span>Fused candidates ({results.length})</span>
        {results.length === 0 && <span className="muted small">No matches above the similarity threshold.</span>}
        <ol className="ranked">
          {results.map((r, i) => (
            <li key={`${r.filepath}:${r.symbol}:${r.start_line}`} style={{ animationDelay: `${i * 70}ms` }}>
              <span className="rank">{i + 1}</span>
              <div className="ranked-body">
                <div className="ranked-top">
                  <span className="ranked-sym">{r.symbol}</span>
                  <span className="ranked-src">
                    {r.sources.map((s) => <i key={s} className={`badge ${s}`}>{s}</i>)}
                  </span>
                </div>
                <div className="ranked-loc mono">{r.filepath}:{r.start_line}</div>
                <div className="score-bar"><span style={{ width: `${Math.max(4, (r.score ?? 0) * 100)}%` }} /></div>
                <div className="score-meta mono">
                  fused {(r.score ?? 0).toFixed(3)}
                  {r.vector_score != null && <> · cos {r.vector_score.toFixed(3)}</>}
                  {r.bm25_score != null && <> · bm25 {r.bm25_score.toFixed(1)}</>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function RerankPanel({ data }: { data: Record<string, any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const results: RetrievedHit[] = data.results ?? []
  return (
    <div className="step-panel">
      <div className="kv"><span>Model</span><b className="mono">{data.model ?? 'disabled'}</b></div>
      <div className="kv">
        <span>Kept</span>
        <b>{data.kept} of {data.candidates}{data.ms != null && <span className="muted"> · {data.ms} ms</span>}</b>
      </div>
      {!data.applied && (
        <p className="warn small">Reranker not applied{data.error ? `: ${data.error}` : ''}. Retrieval order kept.</p>
      )}
      <ol className="ranked rerank-list">
        {results.map((r, i) => {
          const moved = (r.retrieval_rank ?? i + 1) - (i + 1)
          return (
            <li key={`${r.filepath}:${r.symbol}:${r.start_line}`} style={{ animationDelay: `${i * 70}ms` }}>
              <span className="rank">{i + 1}</span>
              <div className="ranked-body">
                <div className="ranked-top">
                  <span className="ranked-sym">{r.symbol}</span>
                  <span className={`move ${moved > 0 ? 'up' : moved < 0 ? 'down' : ''}`} title={`Was #${r.retrieval_rank}`}>
                    {moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : '='}
                  </span>
                </div>
                <div className="ranked-loc mono">{r.filepath}:{r.start_line}</div>
                {r.rerank_score != null && (
                  <div className="dual-bar" aria-hidden>
                    <span className="ce" style={{ width: `${Math.max(3, r.rerank_score * 100)}%` }} />
                    <span className="rt" style={{ width: `${Math.max(3, (r.retrieval_score ?? 0) * 100)}%` }} />
                  </div>
                )}
                <div className="score-meta mono">
                  final {(r.score ?? 0).toFixed(3)}
                  {r.rerank_score != null && <> · cross-enc {r.rerank_score.toFixed(3)}</>}
                  {r.retrieval_score != null && <> · fused {r.retrieval_score.toFixed(3)} (#{r.retrieval_rank})</>}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      {data.applied && <p className="muted tiny">Final = {data.weight} × cross-encoder + {(1 - data.weight).toFixed(2)} × fused retrieval score.</p>}
    </div>
  )
}

/** Callers → symbol → callees, drawn as a three-column tree. */
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
    const H = Math.max(...cols.map((c) => c.length), 1) * 34 + 20
    const pos = new Map<string, { x: number; y: number }>()
    const xs = [80, 290, 500]
    cols.forEach((col, ci) => col.forEach((id, i) => pos.set(id, { x: xs[ci], y: ((i + 0.5) * (H - 20)) / col.length + 10 })))
    const kind = new Map(nodes.map((n) => [n.id, n.kind]))
    const drawn = edges.filter((e) => pos.has(e.source) && pos.has(e.target))
    return { cols, pos, H, kind, drawn }
  }, [nodes, edges])

  const short = (id: string) => (id.length > 22 ? '…' + id.slice(-21) : id)
  return (
    <svg viewBox={`0 0 580 ${layout.H}`} className="call-tree" role="img" aria-label="Call tree">
      <text x="80" y="10" className="col-title">callers</text>
      <text x="290" y="10" className="col-title">retrieved</text>
      <text x="500" y="10" className="col-title">callees · members</text>
      {layout.drawn.map((e, i) => {
        const a = layout.pos.get(e.source)!, b = layout.pos.get(e.target)!
        const mx = (a.x + b.x) / 2
        return (
          <path
            key={i}
            d={`M${a.x + 70} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x - 70} ${b.y}`}
            className="tree-edge"
            stroke={hex(EDGE_COLORS[e.type] ?? 0x8890b0)}
            style={{ animationDelay: `${i * 40}ms` }}
          />
        )
      })}
      {layout.cols.flatMap((col, ci) => col.map((id, i) => {
        const p = layout.pos.get(id)!
        return (
          <g key={id + ci} className={`tree-node ${ci === 1 ? 'anchor' : ''}`} style={{ animationDelay: `${ci * 150 + i * 40}ms` }}>
            <rect x={p.x - 70} y={p.y - 12} width="140" height="24" rx="7" stroke={hex(KIND_COLORS[layout.kind.get(id) ?? ''] ?? 0x8890b0)} />
            <text x={p.x} y={p.y + 4} textAnchor="middle"><title>{id}</title>{short(id)}</text>
          </g>
        )
      }))}
    </svg>
  )
}

function GraphPanel({ data }: { data: Record<string, any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [mode, setMode] = useState<'tree' | '3d'>('tree')
  const nodes: GraphNode[] = data.nodes ?? []
  const edges: GraphEdge[] = data.edges ?? []
  const expanded: ExpandedHit[] = data.expanded ?? []
  const impact: { name: string; total: number; truncated: boolean; depth: number; files: { filepath: string; count: number }[] }[] = data.impact ?? []
  if (!nodes.length && !expanded.length && !impact.length) return <div className="step-panel"><span className="muted small">No structural relationships found for these symbols.</span></div>
  return (
    <div className="step-panel">
      {nodes.length > 0 && (
        <>
          <div className="panel-toolbar">
            <span className="muted small">
              {nodes.length} symbols · {edges.length} relationships{data.depth ? ` · ${data.depth} hop${data.depth > 1 ? 's' : ''}` : ''}
            </span>
            <div className="seg">
              <button className={mode === 'tree' ? 'on' : ''} onClick={() => setMode('tree')}>Tree</button>
              <button className={mode === '3d' ? 'on' : ''} onClick={() => setMode('3d')}>3D</button>
            </div>
          </div>
          {mode === 'tree' ? <CallTree nodes={nodes} edges={edges} /> : <ForceGraph3D nodes={nodes} edges={edges} className="mini-graph" />}
        </>
      )}
      {impact.map((r) => (
        <div key={r.name} className="kv col">
          <span>Impact of <b className="mono">{r.name}</b></span>
          <p className="impact-sum">
            <b>{r.total}{r.truncated ? '+' : ''}</b> symbols across <b>{r.files.length}</b> files
            <span className="muted"> · up to {r.depth} hops</span>
          </p>
          <Chips items={r.files.slice(0, 6).map((f) => `${f.filepath} · ${f.count}`)} />
        </div>
      ))}
      {expanded.length > 0 && (
        <div className="kv col">
          <span>Code pulled in via the graph</span>
          <ol className="ranked">
            {expanded.map((r, i) => (
              <li key={`${r.filepath}:${r.symbol}:${r.start_line}`} style={{ animationDelay: `${i * 70}ms` }}>
                <span className="rank">+</span>
                <div className="ranked-body">
                  <div className="ranked-top"><span className="ranked-sym">{r.symbol}</span></div>
                  <div className="ranked-loc mono">{r.filepath}:{r.start_line}</div>
                  <div className="score-meta">{r.reason}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

function FetchMorePanel({ data }: { data: Record<string, any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const items: { item: string; found: { symbol: string; filepath: string; start_line: number }[] }[] = data.items ?? []
  return (
    <div className="step-panel">
      {items.map(({ item, found }) => (
        <div key={item} className="kv col">
          <span>Asked for <b className="mono">{item}</b></span>
          {found.length ? (
            <ol className="ranked">
              {found.map((f) => (
                <li key={`${f.filepath}:${f.symbol}`}>
                  <span className="rank">+</span>
                  <div className="ranked-body">
                    <div className="ranked-top"><span className="ranked-sym">{f.symbol}</span></div>
                    <div className="ranked-loc mono">{f.filepath}:{f.start_line}</div>
                  </div>
                </li>
              ))}
            </ol>
          ) : <span className="muted small">Nothing new found (already in the context, or not in the index).</span>}
        </div>
      ))}
    </div>
  )
}

function StepBody({ node, event, msg }: { node: UiStep; event?: StepEvent; msg: Message }) {
  if (node === 'generate') {
    if (msg.pending || !msg.finishedAt || !msg.startedAt) return null
    return <div className="step-panel"><span className="muted small">Answered in {((msg.finishedAt - msg.startedAt) / 1000).toFixed(1)}s</span></div>
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

export default function PipelineInspector({ msg, question }: { msg: Message | null; question?: string }) {
  const [collapsed, setCollapsed] = useState<Set<UiStep>>(new Set())
  useEffect(() => setCollapsed(new Set()), [msg?.id])

  if (!msg) {
    return (
      <div className="inspector-empty">
        <MiniCity small />
        <p className="muted">Ask a question to watch the pipeline run step by step.</p>
      </div>
    )
  }
  const steps = stepsFor(msg)
  const states = stepStates(msg)
  const events = new Map((msg.trace ?? []).map((e) => [e.node, e]))
  const errors = (msg.trace ?? []).at(-1)?.errors ?? []
  const doneCount = steps.filter((s) => states[s.node] === 'done').length

  return (
    <div className="inspector">
      {question && <div className="inspector-q">“{question}”</div>}
      <div className="inspector-progress"><span style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
      <ol className="pipe">
        {steps.map((s, i) => {
          const st = states[s.node]
          const open = st === 'done' && !collapsed.has(s.node)
          return (
            <li key={s.node} className={`pipe-step ${st}`}>
              <div className="pipe-rail" aria-hidden><span className="pipe-node">{st === 'done' ? '✓' : st === 'failed' ? '!' : i + 1}</span></div>
              <div className="pipe-content">
                <button
                  className="pipe-head"
                  disabled={st !== 'done'}
                  onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(s.node)) n.delete(s.node); else n.add(s.node); return n })}
                >
                  <span className="pipe-label">{s.label}</span>
                  <span className="pipe-state">{st === 'active' ? 'running' : st}</span>
                </button>
                <p className="pipe-sub">{s.sub}</p>
                {st === 'active' && <div className="shimmer" />}
                {open && <StepBody node={s.node} event={events.get(s.node as StepNode)} msg={msg} />}
              </div>
            </li>
          )
        })}
      </ol>
      {errors.length > 0 && (
        <details className="pipe-errors">
          <summary>{errors.length} retrieval note{errors.length > 1 ? 's' : ''}</summary>
          <ul>{errors.map((e) => <li key={e} className="mono">{e}</li>)}</ul>
        </details>
      )}
    </div>
  )
}
