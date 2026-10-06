import { useEffect, useState } from 'react'
import IngestScene, { INGEST_STAGES } from '../components/IngestScene'
import { navigate } from '../router'
import { repoName, useRepos, type Repo } from '../state'

const STAGE_COPY: Record<string, string> = {
  CLONING: 'Shallow-cloning the repository into a temporary workspace.',
  PARSING: 'Walking every Python, JavaScript and TypeScript file and splitting it at class, method and function boundaries.',
  EMBEDDING: 'Turning each chunk into a vector, in cached batches.',
  STORING: 'Writing symbols to Neo4j, vectors to Qdrant and text to RediSearch.',
  LINKING: 'Resolving calls, inheritance and class membership into graph edges.',
}

function stageIndex(repo: Repo | null): number {
  if (!repo) return -1
  if (repo.state === 'ready') return INGEST_STAGES.length
  if (repo.state === 'failed') return -1
  const i = INGEST_STAGES.findIndex((s) => s.key === repo.stage)
  return i < 0 ? 0 : i
}

function pct(done?: number, total?: number) {
  if (!total) return 0
  return Math.min(100, Math.round(((done ?? 0) / total) * 100))
}

function Elapsed({ since, until }: { since?: number; until?: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (until) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [until])
  if (!since) return null
  const s = Math.max(0, Math.round(((until ?? now) - since) / 1000))
  return <span className="mono">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
}

function StageDetail({ repo, index }: { repo: Repo; index: number }) {
  const p = repo.progress ?? {}
  const key = INGEST_STAGES[index].key
  if (key === 'PARSING' && p.files_total) {
    return <Meter label={`${p.files_done ?? 0} of ${p.files_total} files, ${p.chunks ?? 0} chunks`} value={pct(p.files_done, p.files_total)} />
  }
  if (key === 'EMBEDDING' && p.chunks_total) {
    return <Meter label={`${p.chunks_done ?? 0} of ${p.chunks_total} chunks embedded`} value={pct(p.chunks_done, p.chunks_total)} />
  }
  if (key === 'STORING' && p.store_total) {
    return <Meter label={`${p.store_done ?? 0} of ${p.store_total} files written`} value={pct(p.store_done, p.store_total)} />
  }
  return <Meter label={repo.progress?.step ?? 'Working…'} indeterminate />
}

function Meter({ label, value = 0, indeterminate }: { label: string; value?: number; indeterminate?: boolean }) {
  return (
    <div className="meter">
      <div className={`meter-bar ${indeterminate ? 'indeterminate' : ''}`}>
        <span style={indeterminate ? undefined : { width: `${value}%` }} />
      </div>
      <span className="meter-label">{label}</span>
    </div>
  )
}

export default function IndexPage() {
  const { repos, active, setActive, index, remove } = useRepos()
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const current = stageIndex(active)

  async function removeRepo(target: string) {
    const ok = window.confirm(
      `Delete ${repoName(target)} from the index?\n\nThis removes its vectors, search entries and call graph for everyone using this server. You can index it again later.`,
    )
    if (!ok) return
    setError('')
    try {
      await remove(target)
    } catch (e) {
      setError(`Couldn't delete ${repoName(target)}: ${(e as Error).message}`)
    }
  }

  async function submit(target: string) {
    setError('')
    setBusy(true)
    try {
      await index(target)
      setUrl('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page index-page">
      <section className="ingest-hero">
        <IngestScene stage={current} className="ingest-canvas" />
        <div className="ingest-hero-copy rise">
          <h1>Index a repository</h1>
          <p className="ingest-sub">Paste a public GitHub URL. Indexing clones it, splits the Python, JS and TS code into symbols, embeds them and links the calls.</p>
          <form
            className="url-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (url.trim()) submit(url.trim())
            }}
          >
            <span className="url-prefix mono" aria-hidden>git</span>
            <input
              type="url"
              placeholder="https://github.com/owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Repository URL"
              autoComplete="off"
            />
            <button className="btn btn-primary" disabled={busy || !url.trim()}>
              {busy ? 'Submitting…' : 'Index'}
            </button>
          </form>
          {error && <p className="form-error">{error}</p>}
          <p className="muted small">Test folders and virtualenvs are skipped.</p>
        </div>
      </section>

      <div className="index-grid">
        <section className="panel stage-panel">
          <header className="panel-head">
            <h2>{active ? repoName(active.url) : 'No repository yet'}</h2>
            {active && (
              <span className={`status-pill ${active.state}`}>
                <span className={`dot ${active.state}`} />
                {active.state === 'indexing' ? 'Indexing' : active.state === 'ready' ? 'Ready' : 'Failed'}
                {active.state !== 'failed' && <Elapsed since={active.startedAt} until={active.indexedAt} />}
              </span>
            )}
          </header>

          {!active && <p className="muted">Enter a repository URL above to watch each stage run.</p>}

          {active && (
            <ol className="stage-list">
              {INGEST_STAGES.map((s, i) => {
                const state = active.state === 'failed' ? (i === 0 ? 'failed' : 'pending')
                  : i < current ? 'done' : i === current ? 'active' : 'pending'
                return (
                  <li key={s.key} className={`stage ${state}`} style={{ '--stage-color': `#${s.color.toString(16).padStart(6, '0')}` } as React.CSSProperties}>
                    <span className="stage-node">{state === 'done' ? '✓' : i + 1}</span>
                    <div className="stage-body">
                      <div className="stage-title">{s.label}</div>
                      <p className="stage-copy">{STAGE_COPY[s.key]}</p>
                      {state === 'active' && <StageDetail repo={active} index={i} />}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}

          {active?.state === 'failed' && (
            <div className="fail-box">
              <pre>{active.error}</pre>
              <button className="btn btn-ghost btn-sm" onClick={() => submit(active.url)}>Retry</button>
            </div>
          )}

          {active?.state === 'ready' && active.result && (
            <div className="result-block rise">
              <div className="stat-grid">
                <div className="stat"><strong>{active.result.parsed_files}</strong><span>files</span></div>
                <div className="stat"><strong>{active.result.symbols}</strong><span>symbols</span></div>
                <div className="stat"><strong>{active.result.call_edges}</strong><span>call edges</span></div>
                <div className="stat"><strong>{active.result.inherits_edges ?? '—'}</strong><span>inheritance</span></div>
              </div>
              {active.result.failed_files > 0 && (
                <p className="warn small">{active.result.failed_files} files could not be ingested.</p>
              )}
              <div className="result-actions">
                <button className="btn btn-primary" onClick={() => navigate('/explore')}>Explore the city</button>
                <button className="btn btn-ghost" onClick={() => navigate('/ask')}>Ask a question</button>
                <button className="btn btn-ghost" onClick={() => submit(active.url)}>Re-index</button>
              </div>
            </div>
          )}
        </section>

        <aside className="panel repo-panel">
          <header className="panel-head"><h2>Repositories</h2></header>
          {repos.length === 0 && <p className="muted small">Indexed repositories appear here.</p>}
          <ul className="repo-cards">
            {repos.map((r) => (
              <li key={r.url} className={r.url === active?.url ? 'selected' : ''}>
                <button className="repo-card" onClick={() => setActive(r.url)}>
                  <span className={`dot ${r.state}`} />
                  <span className="repo-card-text">
                    <strong>{repoName(r.url)}</strong>
                    <span>
                      {r.state === 'ready' && (r.result
                        ? `${r.result.symbols} symbols, ${r.result.call_edges} calls`
                        : `${r.symbols ?? '?'} symbols`)}
                      {r.state === 'indexing' && (INGEST_STAGES.find((s) => s.key === r.stage)?.label ?? 'Queued')}
                      {r.state === 'failed' && 'Failed'}
                    </span>
                  </span>
                </button>
                <button
                  className="icon"
                  aria-label={`Delete ${repoName(r.url)} from the index`}
                  title="Delete from the index"
                  disabled={r.state === 'indexing'}
                  onClick={() => removeRepo(r.url)}
                >×</button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  )
}
