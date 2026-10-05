import { useEffect, useMemo, useState } from 'react'
import { getImpact, getRepoGraph, type GraphEdge, type GraphNode, type ImpactReport, type RepoGraph } from '../api'
import CodeCity from '../components/CodeCity'
import FileTree from '../components/FileTree'
import ForceGraph3D, { EDGE_COLORS, KIND_COLORS } from '../components/ForceGraph3D'
import MiniCity from '../components/MiniCity'
import { navigate } from '../router'
import { repoName, useRepos } from '../state'
import { load, save } from '../storage'

import { hex } from '../palette'

function EmptyState({ title, body, action }: { title: string; body: string; action?: { label: string; to: '/index' } }) {
  return (
    <div className="empty-state rise">
      <MiniCity />
      <h2>{title}</h2>
      <p className="muted">{body}</p>
      {action && <button className="btn btn-primary" onClick={() => navigate(action.to)}>{action.label}</button>}
    </div>
  )
}

function Neighbours({ title, items, onPick }: { title: string; items: { node: GraphNode; type: string }[]; onPick: (id: string) => void }) {
  if (!items.length) return null
  return (
    <div className="nb">
      <h4>{title} <span className="muted">{items.length}</span></h4>
      <ul>
        {items.slice(0, 30).map(({ node, type }) => (
          <li key={node.id + type}>
            <button onClick={() => onPick(node.id)}>
              <span className="kind-dot" style={{ background: hex(KIND_COLORS[node.kind] ?? 0xc9d4ff) }} />
              <span className="nb-name">{node.name ?? node.id}</span>
              <span className="nb-type" style={{ color: hex(EDGE_COLORS[type] ?? 0x8890b0) }}>{type.replace('_', ' ').toLowerCase()}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const nodeId = (filepath: string, name: string) => `${filepath}::${name}`

function ImpactPanel({ report, visible, onPick }: { report: ImpactReport; visible: Set<string>; onPick: (id: string) => void }) {
  const hidden = report.affected.filter((a) => !visible.has(nodeId(a.filepath, a.name))).length
  if (!report.total) return <p className="muted small impact-none">Nothing in the indexed code depends on this symbol.</p>
  return (
    <div className="impact">
      <h4 className="impact-head">Impact of <span className="mono">{report.name}</span></h4>
      <p className="impact-sum">
        <b>{report.total}{report.truncated ? '+' : ''}</b> symbols across <b>{report.files.length}</b> files could be affected
        <span className="muted"> · up to {report.depth} hops</span>
      </p>
      {hidden > 0 && <p className="muted small">{hidden} of them aren't among the towers shown; raise “Top N” to see them.</p>}
      {report.files.map((f) => (
        <div key={f.filepath} className="impact-file">
          <h4 className="mono">{f.filepath} <span className="muted">{f.count}</span></h4>
          <ul>
            {report.affected.filter((a) => a.filepath === f.filepath).map((a) => {
              const id = nodeId(a.filepath, a.name)
              return (
                <li key={id}>
                  <button onClick={() => onPick(id)} disabled={!visible.has(id)} title={`${a.relation} ${a.via.name}`}>
                    <span className={`hop hop-${Math.min(a.hops, 3)}`}>{a.hops}</span>
                    <span className="nb-name">{a.name}</span>
                    <span className="nb-type">{a.relation}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

export default function ExplorePage() {
  const { active } = useRepos()
  const [graph, setGraph] = useState<RepoGraph | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [limit, setLimit] = useState(400)
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [impact, setImpact] = useState<{ id: string; report?: ImpactReport; error?: string } | null>(null)
  const [view, setView] = useState<'city' | 'graph'>(() => load('explore-view', 'city'))
  const switchView = (v: 'city' | 'graph') => {
    setView(v)
    save('explore-view', v)
  }

  const ready = active?.state === 'ready'
  useEffect(() => {
    if (!ready || !active) return
    let cancelled = false
    setLoading(true)
    setError('')
    setSelected(null)
    setFile(null)
    setImpact(null)
    getRepoGraph(active.url, limit)
      .then((g) => { if (!cancelled) setGraph(g) })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active?.url, ready, limit]) // eslint-disable-line react-hooks/exhaustive-deps

  // Memoised: a fresh `[]` each render would invalidate every useMemo below.
  const nodes = useMemo(() => graph?.nodes ?? [], [graph])
  const edges = useMemo(() => graph?.edges ?? [], [graph])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const cityNodes = useMemo(
    () => nodes.map((n) => ({ ...n, lines: n.start_line && n.end_line ? n.end_line - n.start_line + 1 : undefined })),
    [nodes],
  )

  const impactIds = useMemo(() => {
    if (!impact?.report) return null
    const r = impact.report
    return new Set([...r.targets, ...r.affected].map((s) => nodeId(s.filepath, s.name)))
  }, [impact])

  const highlight = useMemo(() => {
    if (impactIds) return impactIds
    const q = query.trim().toLowerCase()
    if (!q && !file) return null
    return new Set(
      nodes
        .filter((n) => (!file || n.filepath === file || n.filepath?.startsWith(file + '/')) && (!q || (n.name ?? '').toLowerCase().includes(q)))
        .map((n) => n.id),
    )
  }, [query, file, nodes, impactIds])

  const visibleIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])
  const pick = (id: string | null) => {
    setSelected(id)
    // Picking a symbol from the impact list keeps the analysis; anything else clears it.
    if (!impact?.report || !id || !impactIds?.has(id)) setImpact(null)
  }
  const runImpact = (node: GraphNode) => {
    if (!active) return
    setImpact({ id: node.id })
    getImpact(active.url, node.name ?? node.id, node.filepath)
      .then((report) => setImpact((cur) => (cur?.id === node.id ? { id: node.id, report } : cur)))
      .catch((e) => setImpact((cur) => (cur?.id === node.id ? { id: node.id, error: (e as Error).message } : cur)))
  }

  const sel = selected ? byId.get(selected) : null
  const neighbours = useMemo(() => {
    const out: { node: GraphNode; type: string }[] = []
    const inc: { node: GraphNode; type: string }[] = []
    if (!selected) return { out, inc }
    edges.forEach((e: GraphEdge) => {
      if (e.source === selected && byId.get(e.target)) out.push({ node: byId.get(e.target)!, type: e.type })
      if (e.target === selected && byId.get(e.source)) inc.push({ node: byId.get(e.source)!, type: e.type })
    })
    return { out, inc }
  }, [selected, edges, byId])

  if (!active) {
    return <div className="page"><EmptyState title="Nothing to explore yet" body="Index a repository to see its call graph in 3D." action={{ label: 'Index a repository', to: '/index' }} /></div>
  }
  if (!ready) {
    return (
      <div className="page">
        <EmptyState
          title={active.state === 'failed' ? 'Indexing failed' : 'Still indexing…'}
          body={active.state === 'failed' ? 'Retry from the Index page.' : `${repoName(active.url)} will appear here once linking finishes.`}
          action={{ label: 'Go to Index', to: '/index' }}
        />
      </div>
    )
  }

  const kindCounts = nodes.reduce<Record<string, number>>((acc, n) => ((acc[n.kind] = (acc[n.kind] ?? 0) + 1), acc), {})

  return (
    <div className="page explore-page">
      <aside className="panel explore-side rise">
        <header className="panel-head">
          <h2>{repoName(active.url)}</h2>
        </header>
        <input
          className="search"
          placeholder="Search symbols…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search symbols"
        />
        <div className="side-label">
          Files {file && <button className="link-btn" onClick={() => setFile(null)}>clear</button>}
        </div>
        <FileTree filepaths={nodes.map((n) => n.filepath ?? '')} selected={file} onSelect={setFile} />
      </aside>

      <section className="explore-stage">
        {loading && <div className="stage-loading"><span className="spinner" /> Loading graph…</div>}
        {error && <div className="stage-loading error">{error}</div>}
        {!loading && !error && nodes.length > 0 && (view === 'city'
          ? <CodeCity nodes={cityNodes} edges={edges} selected={selected} highlight={highlight} onSelect={pick} className="explore-graph" />
          : <ForceGraph3D nodes={nodes} edges={edges} selected={selected} highlight={highlight} onSelect={pick} className="explore-graph" />
        )}
        <div className="view-switch seg" role="group" aria-label="View">
          <button className={view === 'city' ? 'on' : ''} aria-pressed={view === 'city'} onClick={() => switchView('city')}>City</button>
          <button className={view === 'graph' ? 'on' : ''} aria-pressed={view === 'graph'} onClick={() => switchView('graph')}>Graph</button>
        </div>
        <div className="graph-hud">
          <div className="legend">
            {Object.entries(KIND_COLORS).map(([k, c]) => (
              <span key={k}><i style={{ background: hex(c) }} />{k} <b>{kindCounts[k] ?? 0}</b></span>
            ))}
            {Object.entries(EDGE_COLORS).filter(([k]) => k !== 'OVERRIDES' && (view === 'graph' || k !== 'HAS_METHOD')).map(([k, c]) => (
              <span key={k}><i className="line" style={{ background: hex(c) }} />{k.replace('_', ' ').toLowerCase()}</span>
            ))}
          </div>
          <div className="hud-right">
            <span className="muted small">
              {nodes.length} of {graph?.total_symbols ?? '?'} symbols, {edges.length} edges
            </span>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Symbols shown">
              {[150, 400, 800, 1500].map((n) => <option key={n} value={n}>Top {n}</option>)}
            </select>
          </div>
        </div>
        <p className="graph-hint">{view === 'city' ? 'Drag to orbit, scroll to zoom, click a tower' : 'Drag to orbit, scroll to zoom, click a node'}</p>
      </section>

      <aside className={`panel explore-detail ${sel ? 'open' : ''}`}>
        {sel ? (
          <>
            <header className="panel-head">
              <div>
                <span className="kind-tag" style={{ color: hex(KIND_COLORS[sel.kind] ?? 0xc9d4ff) }}>{sel.kind}</span>
                <h2 className="break">{sel.name}</h2>
              </div>
              <button className="icon" aria-label="Close" onClick={() => pick(null)}>×</button>
            </header>
            <code className="loc">{sel.filepath}:{sel.start_line}–{sel.end_line}</code>
            <div className="mini-stats">
              <span><b>{neighbours.out.length}</b> outgoing</span>
              <span><b>{neighbours.inc.length}</b> incoming</span>
              <span><b>{sel.degree ?? 0}</b> degree</span>
            </div>
            <div className="detail-actions">
              <button
                className={`btn btn-sm ${impact?.report ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => (impact?.report ? setImpact(null) : runImpact(sel))}
                disabled={impact != null && !impact.report && !impact.error}
              >
                {impact && !impact.report && !impact.error ? 'Tracing…' : impact?.report ? 'Clear impact' : 'What breaks if this changes?'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => navigate('/ask')}>Ask about this symbol</button>
            </div>
            {impact?.error && <p className="warn small">{impact.error}</p>}
            {impact?.report && <ImpactPanel report={impact.report} visible={visibleIds} onPick={pick} />}
            {!impact?.report && (
              <>
                <Neighbours title="Calls / contains" items={neighbours.out} onPick={pick} />
                <Neighbours title="Called by / owned by" items={neighbours.inc} onPick={pick} />
              </>
            )}
          </>
        ) : (
          <div className="detail-empty">
            <h2>Nothing selected</h2>
            <p className="muted">Click a tower or node to see where it's defined, what it calls and what calls it.</p>
          </div>
        )}
      </aside>
    </div>
  )
}
