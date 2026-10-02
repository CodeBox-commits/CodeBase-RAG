import { useEffect, useMemo, useState } from 'react'
import { getRepoGraph, type GraphEdge, type GraphNode, type RepoGraph } from '../api'
import FileTree from '../components/FileTree'
import ForceGraph3D, { EDGE_COLORS, KIND_COLORS } from '../components/ForceGraph3D'
import { navigate } from '../router'
import { repoName, useRepos } from '../state'

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`

function EmptyState({ title, body, action }: { title: string; body: string; action?: { label: string; to: '/index' } }) {
  return (
    <div className="empty-state rise">
      <div className="empty-orb" aria-hidden />
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

export default function ExplorePage() {
  const { active } = useRepos()
  const [graph, setGraph] = useState<RepoGraph | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [limit, setLimit] = useState(400)
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const ready = active?.state === 'ready'
  useEffect(() => {
    if (!ready || !active) return
    let cancelled = false
    setLoading(true)
    setError('')
    setSelected(null)
    setFile(null)
    getRepoGraph(active.url, limit)
      .then((g) => { if (!cancelled) setGraph(g) })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active?.url, ready, limit]) // eslint-disable-line react-hooks/exhaustive-deps

  const nodes = graph?.nodes ?? []
  const edges = graph?.edges ?? []
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const highlight = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q && !file) return null
    return new Set(
      nodes
        .filter((n) => (!file || n.filepath === file || n.filepath?.startsWith(file + '/')) && (!q || (n.name ?? '').toLowerCase().includes(q)))
        .map((n) => n.id),
    )
  }, [query, file, nodes])

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
          <div>
            <span className="kicker">Repository</span>
            <h2>{repoName(active.url)}</h2>
          </div>
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
        {!loading && !error && nodes.length > 0 && (
          <ForceGraph3D nodes={nodes} edges={edges} selected={selected} highlight={highlight} onSelect={setSelected} className="explore-graph" />
        )}
        <div className="graph-hud">
          <div className="legend">
            {Object.entries(KIND_COLORS).map(([k, c]) => (
              <span key={k}><i style={{ background: hex(c) }} />{k} <b>{kindCounts[k] ?? 0}</b></span>
            ))}
            {Object.entries(EDGE_COLORS).map(([k, c]) => (
              <span key={k}><i className="line" style={{ background: hex(c) }} />{k.replace('_', ' ').toLowerCase()}</span>
            ))}
          </div>
          <div className="hud-right">
            <span className="muted small">
              {nodes.length} of {graph?.total_symbols ?? '?'} symbols · {edges.length} edges
            </span>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Symbols shown">
              {[150, 400, 800, 1500].map((n) => <option key={n} value={n}>Top {n}</option>)}
            </select>
          </div>
        </div>
        <p className="graph-hint">Drag to orbit · scroll to zoom · click a node</p>
      </section>

      <aside className={`panel explore-detail ${sel ? 'open' : ''}`}>
        {sel ? (
          <>
            <header className="panel-head">
              <div>
                <span className="kicker" style={{ color: hex(KIND_COLORS[sel.kind] ?? 0xc9d4ff) }}>{sel.kind}</span>
                <h2 className="break">{sel.name}</h2>
              </div>
              <button className="icon" aria-label="Close" onClick={() => setSelected(null)}>×</button>
            </header>
            <code className="loc">{sel.filepath}:{sel.start_line}–{sel.end_line}</code>
            <div className="mini-stats">
              <span><b>{neighbours.out.length}</b> outgoing</span>
              <span><b>{neighbours.inc.length}</b> incoming</span>
              <span><b>{sel.degree ?? 0}</b> degree</span>
            </div>
            <Neighbours title="Calls / contains" items={neighbours.out} onPick={setSelected} />
            <Neighbours title="Called by / owned by" items={neighbours.inc} onPick={setSelected} />
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/ask')}>Ask about this →</button>
          </>
        ) : (
          <div className="detail-empty">
            <span className="kicker">Inspector</span>
            <p className="muted">Click any node to see where it's defined, what it calls and what calls it.</p>
          </div>
        )}
      </aside>
    </div>
  )
}
