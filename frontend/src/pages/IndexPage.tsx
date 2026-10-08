import { Check, Compass, MessageSquareText, MoreHorizontal, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { getRepoGraph, type IndexResult, type RepoGraph } from '../api'
import CodeCity from '../components/CodeCity'
import MiniCity from '../components/MiniCity'
import { StatusDot } from '../components/Nav'
import { navigate } from '../router'
import { repoName, useRepos, type Repo } from '../state'

const STAGES = [
  { key: 'CLONING', label: 'Clone', body: 'A shallow copy of the default branch, in a temporary folder.' },
  { key: 'PARSING', label: 'Parse', body: 'Every Python, JavaScript and TypeScript file, split at each function, method and class.' },
  { key: 'EMBEDDING', label: 'Embed', body: 'Each changed chunk becomes a vector, locally and in batches. Unchanged files are skipped.' },
  { key: 'STORING', label: 'Store', body: 'Symbols to Neo4j, vectors to Qdrant, searchable text to RediSearch.' },
  { key: 'LINKING', label: 'Link', body: 'Calls, inheritance and class members become edges in the graph.' },
] as const

function stageIndex(repo: Repo | null): number {
  if (!repo) return -1
  if (repo.state === 'ready') return STAGES.length
  if (repo.state === 'failed') return -1
  const i = STAGES.findIndex((s) => s.key === repo.stage)
  return i < 0 ? 0 : i
}

const pct = (done?: number, total?: number) => (total ? Math.min(100, Math.round(((done ?? 0) / total) * 100)) : 0)

function ago(ts?: number) {
  if (!ts) return null
  const s = Math.round((ts - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const abs = Math.abs(s)
  if (abs < 60) return rtf.format(s, 'second')
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  return rtf.format(Math.round(s / 86400), 'day')
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
  return <span className="tabular-nums">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
}

function Meter({ label, value, indeterminate }: { label: string; value?: number; indeterminate?: boolean }) {
  return (
    <div className="mt-2.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-rule-soft" role="progressbar" aria-valuenow={indeterminate ? undefined : value} aria-label={label}>
        <div
          className={cn('h-full rounded-full bg-thread shadow-[0_0_10px_rgb(177_140_255/0.6)] transition-[width] duration-500', indeterminate && 'w-1/3 animate-[slide_1.4s_ease-in-out_infinite]')}
          style={indeterminate ? undefined : { width: `${value ?? 0}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">{label}</p>
    </div>
  )
}

function StageDetail({ repo, index }: { repo: Repo; index: number }) {
  const p = repo.progress ?? {}
  const key = STAGES[index].key
  if (key === 'PARSING' && p.files_total) {
    return <Meter label={`${p.files_done ?? 0} of ${p.files_total} files, ${p.chunks ?? 0} chunks so far${p.mode === 'incremental' ? `, ${p.files_changed ?? 0} changed` : ''}`} value={pct(p.files_done, p.files_total)} />
  }
  if (key === 'EMBEDDING' && p.chunks_total) {
    return <Meter label={`${p.chunks_done ?? 0} of ${p.chunks_total} chunks embedded`} value={pct(p.chunks_done, p.chunks_total)} />
  }
  if (key === 'STORING' && p.store_total) {
    return <Meter label={`${p.store_done ?? 0} of ${p.store_total} files written`} value={pct(p.store_done, p.store_total)} />
  }
  return <Meter label={p.step ?? 'Working'} indeterminate />
}

function RunSummary({ result }: { result: IndexResult }) {
  if (result.mode === 'up_to_date') {
    return <>Already up to date{result.commit ? ` at commit ${result.commit.slice(0, 8)}` : ''}, so nothing was re-embedded.</>
  }
  if (!result.files) return null
  const { added, modified, deleted, unchanged } = result.files
  if (result.mode === 'full') {
    return <>Built from scratch: {added} files and {result.embedded_chunks ?? '?'} chunks{deleted ? `, with ${deleted} stale files removed` : ''}.</>
  }
  const changed = added + modified
  return (
    <>
      Updated {changed} changed {changed === 1 ? 'file' : 'files'}{added ? ` (${added} new)` : ''}{deleted ? ` and removed ${deleted}` : ''}.{' '}
      {unchanged} files were unchanged, and {result.embedded_chunks ?? 0} chunks were re-embedded.
    </>
  )
}

/** The finished repository rises as a city: the reward for waiting. */
function BuiltModel({ url }: { url: string }) {
  const [graph, setGraph] = useState<RepoGraph | null>(null)
  useEffect(() => {
    let cancelled = false
    getRepoGraph(url, 250).then((g) => { if (!cancelled) setGraph(g) }).catch(() => {})
    return () => { cancelled = true }
  }, [url])
  const nodes = useMemo(
    () => (graph?.nodes ?? []).map((n) => ({ ...n, lines: n.start_line && n.end_line ? n.end_line - n.start_line + 1 : undefined })),
    [graph],
  )
  if (!nodes.length) return <div className="h-72 animate-pulse rounded-xl bg-sheet-2" aria-hidden />
  return <CodeCity nodes={nodes} edges={graph!.edges} controls={false} framing={1.05} className="h-72 sm:h-80" />
}

function RepoRow({ repo, active, onSelect, onUpdate, onRebuild, onDelete }: {
  repo: Repo; active: boolean; onSelect: () => void; onUpdate: () => void; onRebuild: () => void; onDelete: () => void
}) {
  const symbols = repo.result?.symbols ?? repo.symbols
  return (
    <li className={cn('group flex items-center gap-1 rounded-lg pr-1 transition-colors', active ? 'bg-sheet ring-1 ring-rule' : 'hover:bg-sheet/70')}>
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left" aria-current={active || undefined}>
        <StatusDot state={repo.state} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[0.8rem] font-medium">{repoName(repo.url)}</span>
          <span className="block text-xs text-muted-foreground">
            {repo.state === 'ready' && (symbols != null ? `${symbols} symbols` : 'Indexed')}
            {repo.state === 'ready' && repo.indexedAt ? `, indexed ${ago(repo.indexedAt)}` : ''}
            {repo.state === 'indexing' && (STAGES.find((s) => s.key === repo.stage)?.label ?? 'Queued')}
            {repo.state === 'failed' && 'Indexing failed'}
          </span>
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Actions for ${repoName(repo.url)}`} disabled={repo.state === 'indexing'}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={onUpdate}><RefreshCw /> Update changed files</DropdownMenuItem>
          <DropdownMenuItem onSelect={onRebuild}><RefreshCw /> Rebuild everything</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}><Trash2 /> Delete from the index</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

export default function IndexPage() {
  const { repos, active, setActive, index, remove } = useRepos()
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const current = stageIndex(active)

  async function submit(target: string, full = false) {
    setError('')
    setBusy(true)
    try {
      await index(target, full)
      setUrl('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    const target = deleting
    setDeleting(null)
    if (!target) return
    try {
      await remove(target)
      toast(`Deleted ${repoName(target)}`, { description: 'Its vectors, search entries and call graph are gone. Index it again any time.' })
    } catch (e) {
      toast.error(`Couldn't delete ${repoName(target)}: ${(e as Error).message}`)
    }
  }

  const onSubmit = (e: FormEvent) => { e.preventDefault(); if (url.trim()) submit(url.trim()) }

  return (
    <div className="mx-auto grid max-w-[1600px] gap-10 px-4 py-10 sm:px-6 lg:grid-cols-12 lg:py-14 xl:px-10">
      <section className="lg:col-span-5">
        <h1 className="display text-[clamp(2.2rem,4vw,3.4rem)]">Index a repository</h1>
        <p className="mt-4 max-w-[46ch] text-muted-foreground">
          Paste a public GitHub URL. Indexing it again later only re-embeds the files that changed.
        </p>
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-2 sm:flex-row">
          <label htmlFor="repo-url" className="sr-only">Public GitHub repository URL</label>
          <input
            id="repo-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repository"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'repo-url-error' : undefined}
            className="h-11 min-w-0 flex-1 rounded-md border bg-sheet px-3.5 font-mono text-[0.85rem] placeholder:text-muted-foreground/70 aria-invalid:border-check"
          />
          <Button type="submit" size="lg" className="h-11" disabled={busy || !url.trim()}>{busy ? 'Starting…' : 'Index'}</Button>
        </form>
        {error && <p id="repo-url-error" className="mt-2 text-sm text-check">{error}</p>}

        <h2 className="mt-12 text-sm font-semibold">On this server</h2>
        {repos.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Repositories you index appear here, for everyone using this server.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {repos.map((r) => (
              <RepoRow
                key={r.url}
                repo={r}
                active={r.url === active?.url}
                onSelect={() => setActive(r.url)}
                onUpdate={() => submit(r.url)}
                onRebuild={() => submit(r.url, true)}
                onDelete={() => setDeleting(r.url)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="lg:col-span-7 lg:pl-6" aria-live="polite">
        {!active ? (
          <div className="grid h-full min-h-80 place-items-center rounded-xl border border-dashed text-center">
            <div className="px-6">
              <MiniCity className="mx-auto h-28 w-40" />
              <p className="mt-4 max-w-[36ch] text-sm text-muted-foreground">Index a repository and each stage shows up here as it runs.</p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border bg-sheet p-5 sm:p-7">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-mono text-[0.95rem] font-semibold">{repoName(active.url)}</h2>
              <p className="text-xs text-muted-foreground">
                {active.state === 'indexing' && <>Running for <Elapsed since={active.startedAt} /></>}
                {active.state === 'ready' && active.startedAt && active.indexedAt && <>Took <Elapsed since={active.startedAt} until={active.indexedAt} /></>}
              </p>
            </div>

            {active.state === 'failed' ? (
              <div className="mt-5 rounded-lg border border-check/40 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-check"><X className="size-4" /> Indexing failed</p>
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[0.76rem] text-muted-foreground">{active.error}</pre>
                <Button variant="outline" size="sm" className="mt-3 bg-sheet" onClick={() => submit(active.url)}>Try again</Button>
              </div>
            ) : active.state === 'ready' && !active.result ? (
              // Indexed elsewhere (another browser, the API, an earlier session): no run details here.
              <div className="mt-5">
                <BuiltModel url={active.url} />
                <p className="mt-4 max-w-[60ch] text-sm text-muted-foreground">
                  {active.symbols != null ? `${active.symbols} symbols` : 'Indexed'}
                  {active.indexedAt ? `, last indexed ${ago(active.indexedAt)}` : ''}. Update it to pick up new commits; only
                  changed files are re-embedded.
                </p>
                <div className="mt-6 flex flex-wrap gap-2">
                  <Button onClick={() => navigate('/explore')}><Compass /> Explore the city</Button>
                  <Button variant="outline" className="bg-sheet" onClick={() => navigate('/ask')}><MessageSquareText /> Ask a question</Button>
                  <Button variant="ghost" onClick={() => submit(active.url)} disabled={busy}><RefreshCw /> Update</Button>
                </div>
              </div>
            ) : active.state === 'ready' && active.result ? (
              <div className="mt-5">
                <BuiltModel url={active.url} />
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                  {[
                    ['files', active.result.parsed_files],
                    ['symbols', active.result.symbols],
                    ['calls linked', active.result.call_edges],
                    ['inheritance links', active.result.inherits_edges ?? 0],
                  ].map(([label, n]) => (
                    <div key={label as string}>
                      <dd className="display text-[2.2rem] tabular-nums">{n}</dd>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                    </div>
                  ))}
                </dl>
                <p className="mt-4 max-w-[60ch] text-sm text-muted-foreground"><RunSummary result={active.result} /></p>
                {active.result.failed_files > 0 && (
                  <p className="mt-2 text-sm text-check">
                    {active.result.failed_files} files couldn't be indexed. They keep their previous data and are retried next time.
                  </p>
                )}
                <div className="mt-6 flex flex-wrap gap-2">
                  <Button onClick={() => navigate('/explore')}><Compass /> Explore the city</Button>
                  <Button variant="outline" className="bg-sheet" onClick={() => navigate('/ask')}><MessageSquareText /> Ask a question</Button>
                </div>
              </div>
            ) : (
              <ol className="relative mt-6">
                <span aria-hidden className="absolute bottom-4 left-3 top-4 w-px bg-rule" />
                {STAGES.map((s, i) => {
                  const state = i < current ? 'done' : i === current ? 'active' : 'pending'
                  return (
                    <li key={s.key} className="relative flex gap-4 pb-6 last:pb-0">
                      <span
                        className={cn(
                          'relative z-10 grid size-6 shrink-0 place-items-center rounded-full border text-[0.72rem] font-semibold tabular-nums',
                          state === 'done' && 'border-rule bg-sheet-2 text-graphite',
                          state === 'active' && 'glow border-thread bg-thread/20 text-thread',
                          state === 'pending' && 'bg-sheet text-muted-foreground',
                        )}
                      >
                        {state === 'done' ? <Check className="size-3.5" /> : i + 1}
                      </span>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <p className={cn('font-semibold', state === 'pending' && 'text-muted-foreground')}>{s.label}</p>
                        <p className="mt-0.5 max-w-[56ch] text-sm text-muted-foreground">{s.body}</p>
                        {state === 'active' && <StageDetail repo={active} index={i} />}
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        )}
      </section>

      <AlertDialog open={deleting != null} onOpenChange={(o) => { if (!o) setDeleting(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting ? repoName(deleting) : ''} from the index?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes its vectors, search entries and call graph for everyone using this server, and clears your conversations
              about it in this browser. You can index it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
