export type TaskState = 'PENDING' | 'CLONING' | 'PARSING' | 'LINKING' | 'SUCCESS' | 'FAILURE' | string

export interface IndexResult {
  status: 'success' | 'partial_success'
  parsed_files: number
  failed_files: number
  symbols: number
  call_edges: number
  repo_url: string
}

export interface TaskStatus {
  task_id: string
  status: TaskState
  message?: string
  result?: IndexResult
  error?: string
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

/** Streams the answer over SSE; calls onToken for every chunk received. */
export async function ask(
  question: string,
  repoUrl: string,
  onToken: (text: string) => void,
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
      if (msg.type === 'token') onToken(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))
    }
  }
}
