export type TaskState =
  | 'PENDING' | 'CLONING' | 'PARSING' | 'EMBEDDING' | 'STORING' | 'LINKING' | 'SUCCESS' | 'FAILURE' | string

export interface IndexResult {
  status: 'success' | 'partial_success'
  parsed_files: number
  failed_files: number
  symbols: number
  call_edges: number
  inherits_edges?: number
  repo_url: string
}

export interface IngestProgress {
  step?: string
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

export type StepNode = 'query_planner' | 'retrieval_router' | 'embed_queries' | 'retrieve' | 'rerank' | 'graph_search'

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
  type: 'CALLS' | 'INHERITS' | 'HAS_METHOD' | string
  hops?: number
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

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (Array.isArray(body.detail)) return body.detail.map((d: { msg: string }) => d.msg).join('; ')
    return body.detail || body.message || res.statusText
  } catch {
    return res.statusText
  }
}

export async function startIndex(repoUrl: string): Promise<{ task_id: string; repo_url: string }> {
  const res = await fetch('/api/v1/repo/index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo_url: repoUrl }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
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

/** Streams pipeline steps and the answer over SSE. */
export async function ask(
  question: string,
  repoUrl: string,
  handlers: { onStep: (e: StepEvent) => void; onToken: (text: string) => void },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/v1/chat/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, repo_url: repoUrl, stream: true }),
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
      if (msg.type === 'token') handlers.onToken(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))
    }
  }
}
