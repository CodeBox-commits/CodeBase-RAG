import { AnimatePresence, motion } from 'motion/react'
import { Code2, FolderTree, MessageSquareText, Search, Target, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { getImpact, getRepoGraph, type GraphEdge, type GraphNode, type ImpactReport, type RepoGraph } from '../api'
import CodeCity from '../components/CodeCity'
import CodeViewer, { type CitationTarget } from '../components/CodeViewer'
import EmptyState from '../components/EmptyState'
import FileTree from '../components/FileTree'
import ForceGraph3D from '../components/ForceGraph3D'
import { EDGE_LABEL, KIND_VAR } from '../palette'
import { navigate } from '../router'
import { repoName, useRepos } from '../state'
import { load, save } from '../storage'

const nodeId = (filepath: string, name: string) => `${filepath}::${name}`
const LIMITS = [150, 400, 800, 1500]

function KindSwatch({ kind, className }: { kind: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2.5 shrink-0 rounded-[2px] border border-graphite/30', className)}
      style={{ background: KIND_VAR[kind] ?? 'var(--kind-method)' }}
    />
  )
}

function Hop({ n }: { n: number }) {
  return (
    <span
      title={`${n} ${n === 1 ? 'step' : 'steps'} away`}
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-full text-[0.68rem] font-semibold tabular-nums',
        n === 1 && 'bg-thread text-[#160936]',
        n === 2 && 'bg-thread/55 text-[#160936]',
        n >= 3 && 'bg-thread/20 text-foreground',
      )}
    >
      {n}
    </span>
  )
}

function Neighbours({ title, items, onPick }: { title: string; items: { node: GraphNode; type: string }[]; onPick: (id: string) => void }) {
  if (!items.length) return null
  return (
    <section className="mt-5">
      <h3 className="mb-1.5 flex items-baseline justify-between text-xs font-semibold text-muted-foreground">
        {title}
        <span className="font-normal tabular-nums">{items.length}</span>
      </h3>
      <ul className="space-y-px">
        {items.slice(0, 40).map(({ node, type }) => (
          <li key={node.id + type}>
            <button onClick={() => onPick(node.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent">
              <KindSwatch kind={node.kind} />
              <span className="min-w-0 flex-1 truncate font-mono text-[0.76rem]">{node.name ?? node.id}</span>
              <span className={cn('shrink-0 text-[0.7rem]', type === 'CALLS' ? 'text-thread' : 'text-muted-foreground')}>{EDGE_LABEL[type] ?? type}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ImpactPanel({ report, visible, onPick }: { report: ImpactReport; visible: Set<string>; onPick: (id: string) => void }) {
  const hidden = report.affected.filter((a) => !visible.has(nodeId(a.filepath, a.name))).length
  if (!report.total) {
    return <p className="mt-5 text-sm text-muted-foreground">Nothing in the indexed code calls, subclasses or overrides this.</p>
  }
  return (
    <section className="mt-5" aria-live="polite">
      <p className="text-sm">
        Changing <span className="font-mono text-[0.85em]">{report.name}</span> can affect{' '}
        <strong className="display text-[1.5rem] text-thread">{report.total}{report.truncated ? '+' : ''}</strong> symbols in{' '}
        <strong className="display text-[1.5rem] text-thread">{report.files.length}</strong> {report.files.length === 1 ? 'file' : 'files'}, up to{' '}
        {report.depth} steps away.
      </p>
      {hidden > 0 && <p className="mt-1.5 text-xs text-muted-foreground">{hidden} of them aren't among the blocks shown. Show more blocks to see them.</p>}
      <div className="mt-4 space-y-4">
        {report.files.map((f) => (
          <div key={f.filepath}>
            <p className="break-all font-mono text-[0.72rem] text-muted-foreground">{f.filepath}</p>
            <ul className="mt-1 space-y-px">
              {report.affected.filter((a) => a.filepath === f.filepath).map((a) => {
                const id = nodeId(a.filepath, a.name)
                return (
                  <li key={id}>
                    <button
                      onClick={() => onPick(id)}
                      disabled={!visible.has(id)}
                      title={`${a.relation} ${a.via.name}`}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:opacity-55 disabled:hover:bg-transparent"
                    >
                      <Hop n={a.hops} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[0.76rem]">{a.name}</span>
                      <span className="text-[0.7rem] text-muted-foreground">{a.relation}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

function FilesPanel({ repo, query, setQuery, filepaths, file, setFile }: {
  repo: string; query: string; setQuery: (q: string) => void; filepaths: string[]; file: string | null; setFile: (f: string | null) => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-3">
        <h2 className="truncate font-mono text-[0.8rem] font-medium">{repoName(repo)}</h2>
        <label className="relative mt-2.5 block">
          <span className="sr-only">Filter blocks by name</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name"
            className="h-8 w-full rounded-md border bg-background/60 pl-8 pr-2 text-[0.8rem] placeholder:text-muted-foreground/70"
          />
        </label>
      </div>
      <div className="flex items-baseline justify-between px-3 pb-1 pt-3 text-xs font-semibold text-muted-foreground">
        Files
        {file && <button className="font-normal text-thread hover:underline" onClick={() => setFile(null)}>Show all</button>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        <FileTree filepaths={filepaths} selected={file} onSelect={setFile} />
      </div>
    </div>
  )
}

export default function ExplorePage() {
  const { active, focusSymbol, setFocusSymbol } = useRepos()
  const [graph, setGraph] = useState<RepoGraph | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [limit, setLimit] = useState(() => load('explore-limit', 400))
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [impact, setImpact] = useState<{ id: string; report?: ImpactReport; error?: string } | null>(null)
  const [code, setCode] = useState<CitationTarget | null>(null)
  const [view, setView] = useState<'model' | 'graph'>(() => (load<string>('explore-view', 'model') === 'graph' ? 'graph' : 'model'))

  // On wide screens the files sheet covers the left edge, so the model is framed to its right.
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1024px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

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

  const nodes = useMemo(() => graph?.nodes ?? [], [graph])
  const edges = useMemo(() => graph?.edges ?? [], [graph])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const visibleIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])
  const cityNodes = useMemo(
    () => nodes.map((n) => ({ ...n, lines: n.start_line && n.end_line ? n.end_line - n.start_line + 1 : undefined })),
    [nodes],
  )

  // A symbol picked in the command menu.
  useEffect(() => {
    if (!focusSymbol || !nodes.length) return
    if (byId.has(focusSymbol)) setSelected(focusSymbol)
    else toast(`${focusSymbol.split('::')[1]} isn't among the ${nodes.length} blocks shown`, { description: 'Show more blocks to find it.' })
    setFocusSymbol(null)
  }, [focusSymbol, nodes, byId, setFocusSymbol])

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
    return <EmptyState title="Nothing to explore yet" body="Index a repository to see it as a model you can walk." action={{ label: 'Index a repository', to: '/index' }} />
  }
  if (!ready) {
    return (
      <EmptyState
        title={active.state === 'failed' ? 'Indexing failed' : 'Still being built'}
        body={active.state === 'failed' ? 'Try again from the Index page.' : `${repoName(active.url)} appears here once its calls are linked.`}
        action={{ label: 'Go to Index', to: '/index' }}
      />
    )
  }

  const kindCounts = nodes.reduce<Record<string, number>>((acc, n) => ((acc[n.kind] = (acc[n.kind] ?? 0) + 1), acc), {})
  const filepaths = nodes.map((n) => n.filepath ?? '')
  const impactBusy = impact != null && !impact.report && !impact.error

  return (
    <div className="relative h-[calc(100svh-3.5rem)] overflow-hidden drafting-grid">
      {/* The model or the graph, full bleed. */}
      {loading && <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Building the model…</p>}
      {error && <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-check">{error}</p>}
      {!loading && !error && nodes.length > 0 && (view === 'model'
        ? <CodeCity nodes={cityNodes} edges={edges} selected={selected} highlight={highlight} onSelect={pick} framing={1.02} offsetX={wide ? 0.09 : 0} className="absolute inset-0" />
        : <ForceGraph3D nodes={nodes} edges={edges} selected={selected} highlight={highlight} onSelect={pick} className="absolute inset-0" />
      )}

      {/* Files: a floating sheet on wide screens, a drawer on narrow ones. */}
      <aside className="absolute bottom-4 left-4 top-4 hidden w-72 overflow-hidden rounded-xl border bg-sheet/95 shadow-[0_1px_0_rgb(0_0_0/0.03)] backdrop-blur lg:block">
        <FilesPanel repo={active.url} query={query} setQuery={setQuery} filepaths={filepaths} file={file} setFile={setFile} />
      </aside>
      <div className="absolute left-4 top-4 lg:hidden">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="bg-sheet"><FolderTree /> Files</Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-80 p-0">
            <SheetTitle className="sr-only">Files</SheetTitle>
            <FilesPanel repo={active.url} query={query} setQuery={setQuery} filepaths={filepaths} file={file} setFile={setFile} />
          </SheetContent>
        </Sheet>
      </div>

      {/* View and size. */}
      <div className={cn('absolute right-4 top-16 flex items-center gap-2 transition-[right] duration-300 sm:top-4', sel && 'lg:right-[24.5rem]')}>
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(v) => { if (v) { setView(v as 'model' | 'graph'); save('explore-view', v) } }}
          variant="outline"
          size="sm"
          className="bg-sheet"
          aria-label="View"
        >
          <ToggleGroupItem value="model" className="px-3">Model</ToggleGroupItem>
          <ToggleGroupItem value="graph" className="px-3">Graph</ToggleGroupItem>
        </ToggleGroup>
        <label className="flex items-center">
          <span className="sr-only">Blocks shown</span>
          <select
            value={limit}
            onChange={(e) => { const n = Number(e.target.value); setLimit(n); save('explore-limit', n) }}
            className="h-8 rounded-md border bg-sheet px-2 text-xs"
          >
            {LIMITS.map((n) => <option key={n} value={n}>Top {n} blocks</option>)}
          </select>
        </label>
      </div>

      {/* Legend: what the colours and shapes mean, and how much of the repository is shown. */}
      <div className="pointer-events-none absolute bottom-4 right-4 flex flex-col items-end gap-1.5 text-xs text-muted-foreground lg:left-[19.5rem] lg:right-auto lg:items-start">
        <div className="pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-sheet/90 px-3 py-1.5 backdrop-blur">
          {(['function', 'method', 'class'] as const).map((k) => (
            <span key={k} className="flex items-center gap-1.5"><KindSwatch kind={k} />{k} <span className="tabular-nums text-foreground">{kindCounts[k] ?? 0}</span></span>
          ))}
          <span className="flex items-center gap-1.5"><span aria-hidden className="h-0.5 w-4 rounded bg-thread" />call</span>
        </div>
        <p className="rounded-md bg-sheet/90 px-3 py-1 backdrop-blur">
          {nodes.length} of {graph?.total_symbols ?? '?'} symbols, by number of links. {view === 'model' ? 'Drag to turn, scroll to zoom, click a block.' : 'Drag to turn, scroll to zoom, click a node.'}
        </p>
      </div>

      {/* Inspector for the selected symbol. */}
      <AnimatePresence>
        {sel && (
          <motion.aside
            key="inspector"
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
            className="absolute inset-x-3 bottom-3 top-auto max-h-[62svh] overflow-y-auto rounded-xl border bg-sheet p-4 lg:inset-x-auto lg:bottom-4 lg:right-4 lg:top-4 lg:max-h-none lg:w-[23.5rem]"
            aria-label="Selected symbol"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><KindSwatch kind={sel.kind} />{sel.kind}</p>
                <h2 className="mt-1 break-all font-mono text-[0.95rem] font-semibold">{sel.name}</h2>
                <p className="mt-1 break-all font-mono text-[0.74rem] text-muted-foreground">{sel.filepath}:{sel.start_line}–{sel.end_line}</p>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => pick(null)}><X /></Button>
            </div>

            <p className="mt-3 text-sm text-muted-foreground">
              Calls or contains <strong className="font-semibold text-foreground">{neighbours.out.length}</strong>, used by{' '}
              <strong className="font-semibold text-foreground">{neighbours.inc.length}</strong> among the blocks shown.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={impact?.report ? 'default' : 'outline'}
                className={cn(!impact?.report && 'bg-sheet')}
                disabled={impactBusy}
                onClick={() => (impact?.report ? setImpact(null) : runImpact(sel))}
              >
                <Target /> {impactBusy ? 'Tracing…' : impact?.report ? 'Clear impact' : 'What breaks if this changes?'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="bg-sheet"
                onClick={() => sel.filepath && sel.start_line && setCode({ text: `${sel.filepath}:${sel.start_line}`, filepath: sel.filepath, line: sel.start_line, end_line: sel.start_line })}
              >
                <Code2 /> Open code
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { save('ask-draft', `How does ${sel.name} work, and what calls it?`); navigate('/ask') }}
              >
                <MessageSquareText /> Ask about it
              </Button>
            </div>

            {impact?.error && <p className="mt-4 text-sm text-check">{impact.error}</p>}
            {impact?.report ? (
              <ImpactPanel report={impact.report} visible={visibleIds} onPick={pick} />
            ) : (
              <>
                <Neighbours title="Calls and contains" items={neighbours.out} onPick={pick} />
                <Neighbours title="Called by and owned by" items={neighbours.inc} onPick={pick} />
              </>
            )}
          </motion.aside>
        )}
      </AnimatePresence>

      <CodeViewer repoUrl={active.url} target={code} onClose={() => setCode(null)} />
    </div>
  )
}
