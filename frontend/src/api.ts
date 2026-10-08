import type { Citation } from './citations'

export type TaskState =
  | 'PENDING' | 'CLONING' | 'PARSING' | 'EMBEDDING' | 'STORING' | 'LINKING' | 'SUCCESS' | 'FAILURE' | string

export interface IndexResult {
  status: 'success' | 'partial_success'
  /** full: everything (re)built · incremental: only changed files · up_to_date: nothing to do */
  mode?: 'full' | 'incremental' | 'up_to_date'
  commit?: string
  parsed_files: number
  failed_files: number
  files?: { added: number; modified: number; deleted: number; unchanged: number }
  embedded_chunks?: number
  symbols: number
  call_edges: number
  inherits_edges?: number
  repo_url: string
}

export interface IngestProgress {
  step?: string
  /** full | incremental, from the worker */
  mode?: string
  files_changed?: number
  files_total?: number
  files_done?: number
  chunks?: number
  chunks_done?: number
  chunks_total?: number
  store_total?: number
  store_done?: number
  symbols?: number
}

export interface TaskStatus {
  task_id: string
  status: TaskState
  message?: string
  progress?: IngestProgress
  result?: IndexResult
  error?: string
}

// ---- agent pipeline events --------------------------------------------------

export type StepNode = 'query_planner' | 'retrieval_router' | 'embed_queries' | 'retrieve' | 'rerank' | 'graph_search' | 'fetch_more'

export interface RetrievedHit {
  symbol: string
  filepath: string
  start_line: number
  end_line: number
  chunk_type: string
  score: number
  rrf_score?: number
  vector_score?: number
  bm25_score?: number
  sources: string[]
  rerank_score?: number
  retrieval_score?: number
  retrieval_rank?: number
}

export interface GraphNode {
  id: string
  name?: string
  kind: string
  filepath?: string | null
  anchor?: boolean
  degree?: number
  start_line?: number
  end_line?: number
}

export interface GraphEdge {
  source: string
  target: string
  type: 'CALLS' | 'INHERITS' | 'HAS_METHOD' | 'OVERRIDES' | string
  hops?: number
}

/** Code the graph step added because a hit points to it (override, callee, named symbol). */
export interface ExpandedHit {
  symbol: string
  filepath: string
  start_line: number
  end_line?: number
  chunk_type?: string
  reason: string
}

export interface StepEvent {
  type: 'step'
  node: StepNode
  data: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  errors: string[]
}

export interface RepoGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  total_symbols: number
}

export interface ImpactItem {
  name: string
  filepath: string
  start_line: number
  end_line: number
  type: string
  hops: number
  relation: 'calls' | 'subclasses' | 'overrides' | string
  via: { name: string; filepath: string }
}

export interface ImpactReport {
  name: string
  depth: number
  targets: { name: string; filepath: string; start_line: number; end_line: number; type: string }[]
  total: number
  truncated: boolean
  files: { filepath: string; count: number; nearest_hops: number; symbols: string[] }[]
  affected: ImpactItem[]
}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (Array.isArray(body.detail)) return body.detail.map((d: { msg: string }) => d.msg).join('; ')
    return body.detail || body.message || res.statusText
  } catch {
    return res.statusText
  }
}

/** Incremental by default: only files changed since the last run are embedded. */
export async function startIndex(repoUrl: string, full = false): Promise<{ task_id: string; repo_url: string }> {
  const res = await fetch('/api/v1/repo/index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo_url: repoUrl, full }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export interface IndexedRepo {
  url: string
  last_indexed: number | null
  symbols: number
}

/** Every repository indexed on the server, whichever browser or client indexed it. */
export async function listRepos(): Promise<IndexedRepo[]> {
  const res = await fetch('/api/v1/repo/list')
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).repositories
}

export async function getStatus(taskId: string): Promise<TaskStatus> {
  const res = await fetch(`/api/v1/repo/status/${encodeURIComponent(taskId)}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function getRepoGraph(repoUrl: string, limit = 400): Promise<RepoGraph> {
  const params = new URLSearchParams({ repo_url: repoUrl, limit: String(limit) })
  const res = await fetch(`/api/v1/repo/graph?${params}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export interface CodeAt {
  name: string
  filepath: string
  start_line: number
  end_line: number
  type: string
  code: string | null
}

/** The indexed symbol containing filepath:line, with its code (what a citation points at). */
export async function getCodeAt(repoUrl: string, filepath: string, line: number): Promise<CodeAt> {
  const params = new URLSearchParams({ repo_url: repoUrl, filepath, line: String(line) })
  const res = await fetch(`/api/v1/symbols/at?${params}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

/** Removes a repository's vectors, search entries and graph from the server. */
export async function deleteRepo(repoUrl: string): Promise<void> {
  const res = await fetch(`/api/v1/repo?${new URLSearchParams({ repo_url: repoUrl })}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error(await readError(res))
}

/** Everything that calls, subclasses or overrides a symbol, up to `depth` hops back. */
export async function getImpact(repoUrl: string, name: string, filepath?: string | null, depth = 3): Promise<ImpactReport> {
  const params = new URLSearchParams({ repo_url: repoUrl, name, depth: String(depth) })
  if (filepath) params.set('filepath', filepath)
  const res = await fetch(`/api/v1/symbols/impact?${params}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export type AnswerStatus = 'ok' | 'fallback_model' | 'degraded'

export interface FinalAnswer {
  content: string
  citations: Citation[]
  status: AnswerStatus
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Streams pipeline steps, then the answer token by token, then the final checked answer
 * (which replaces the streamed text: it differs when a fallback took over).
 */
export async function ask(
  question: string,
  repoUrl: string,
  options: { history: ChatTurn[]; allowFollowup: boolean },
  handlers: { onStep: (e: StepEvent) => void; onToken: (text: string) => void; onAnswer: (a: FinalAnswer) => void },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/v1/chat/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      repo_url: repoUrl,
      stream: true,
      history: options.history,
      allow_followup: options.allowFollowup,
    }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(await readError(res))

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const evt of events) {
      const data = evt.replace(/^data: ?/, '')
      if (!data || data === '[DONE]') continue
      const msg = JSON.parse(data)
      if (msg.type === 'error') throw new Error(msg.message)
      if (msg.type === 'step') handlers.onStep(msg as StepEvent)
      if (msg.type === 'token') handlers.onToken(typeof msg.content === 'string' ? msg.content : '')
      if (msg.type === 'answer') {
        handlers.onAnswer({ content: String(msg.content ?? ''), citations: msg.citations ?? [], status: msg.status ?? 'ok' })
      }
    }
  }
}
