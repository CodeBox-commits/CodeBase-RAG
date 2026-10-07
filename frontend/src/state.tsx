import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { deleteRepo, getStatus, listRepos, startIndex, type AnswerStatus, type IndexResult, type IngestProgress, type StepEvent } from './api'
import type { Citation } from './citations'
import { mergeServerRepos } from './repoList'
import { load, save } from './storage'

export type RepoState = 'indexing' | 'ready' | 'failed'

export interface Repo {
  url: string
  /** Indexed symbol count as reported by the server. */
  symbols?: number
  taskId?: string
  state: RepoState
  stage?: string
  progress?: IngestProgress
  result?: IndexResult
  error?: string
  startedAt?: number
  indexedAt?: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  error?: boolean
  trace?: StepEvent[]
  startedAt?: number
  finishedAt?: number
  citations?: Citation[]
  status?: AnswerStatus
}

interface RepoContextValue {
  repos: Repo[]
  active: Repo | null
  setActive: (url: string) => void
  index: (url: string, full?: boolean) => Promise<Repo>
  /** Deletes the repository's index on the server, then forgets it here. */
  remove: (url: string) => Promise<void>
  chats: Record<string, Message[]>
  updateChat: (url: string, fn: (m: Message[]) => Message[]) => void
}

const RepoContext = createContext<RepoContextValue | null>(null)

export function repoName(url: string) {
  return url.replace(/\/+$/, '').split('/').slice(-2).join('/')
}

export function RepoProvider({ children }: { children: ReactNode }) {
  const [repos, setRepos] = useState<Repo[]>(() => load('repos', []))
  const [activeUrl, setActiveUrl] = useState<string | null>(() => load('active', null))
  const [chats, setChats] = useState<Record<string, Message[]>>(() => {
    // A reply still pending when the page closed will never complete; don't show it spinning forever.
    const saved = load<Record<string, Message[]>>('chats', {})
    return Object.fromEntries(
      Object.entries(saved).map(([url, msgs]) => [
        url,
        msgs.map((m) => (m.pending ? { ...m, pending: false, error: true, content: 'Interrupted — ask again.' } : m)),
      ]),
    )
  })

  useEffect(() => { save('repos', repos) }, [repos])
  useEffect(() => { save('active', activeUrl) }, [activeUrl])
  useEffect(() => { save('chats', chats) }, [chats])

  // The server is the source of truth for what's indexed: add repos indexed elsewhere
  // (another browser, the dev server on :5173, the API or an MCP client).
  useEffect(() => {
    listRepos()
      .then((server) => {
        setRepos((rs) => mergeServerRepos(rs, server))
        setActiveUrl((cur) => cur ?? server[0]?.url ?? null)
      })
      .catch(() => { /* offline or old backend: the local list still works */ })
  }, [])

  const patch = (url: string, p: Partial<Repo>) =>
    setRepos((rs) => rs.map((r) => (r.url === url ? { ...r, ...p } : r)))

  // Poll every in-flight indexing task.
  const indexing = repos.filter((r) => r.state === 'indexing' && r.taskId)
  const key = indexing.map((r) => r.taskId).join(',')
  useEffect(() => {
    if (!key) return
    const tick = async () => {
      for (const repo of indexing) {
        try {
          const s = await getStatus(repo.taskId!)
          if (s.status === 'SUCCESS') patch(repo.url, { state: 'ready', result: s.result, stage: 'DONE', indexedAt: Date.now() })
          else if (s.status === 'FAILURE') patch(repo.url, { state: 'failed', error: s.error, stage: 'FAILED' })
          else patch(repo.url, { stage: s.status, progress: s.progress ?? repo.progress })
        } catch {
          /* transient; next tick retries */
        }
      }
    }
    tick()
    const id = setInterval(tick, 1500)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  async function index(url: string, full = false) {
    const { task_id, repo_url } = await startIndex(url, full)
    const repo: Repo = { url: repo_url, taskId: task_id, state: 'indexing', stage: 'PENDING', startedAt: Date.now() }
    setRepos((rs) => [repo, ...rs.filter((r) => r.url !== repo_url)])
    setActiveUrl(repo_url)
    return repo
  }

  async function remove(url: string) {
    await deleteRepo(url)
    setRepos((rs) => rs.filter((r) => r.url !== url))
    setChats(({ [url]: _, ...rest }) => rest)
    if (activeUrl === url) setActiveUrl(null)
  }

  const active = repos.find((r) => r.url === activeUrl) ?? null

  return (
    <RepoContext.Provider
      value={{
        repos,
        active,
        setActive: setActiveUrl,
        index,
        remove,
        chats,
        updateChat: (url, fn) => setChats((c) => ({ ...c, [url]: fn(c[url] ?? []) })),
      }}
    >
      {children}
    </RepoContext.Provider>
  )
}

export function useRepos() {
  const ctx = useContext(RepoContext)
  if (!ctx) throw new Error('useRepos must be used inside RepoProvider')
  return ctx
}
