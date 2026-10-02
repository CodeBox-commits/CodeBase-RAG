import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { getStatus, startIndex, type IndexResult, type IngestProgress, type StepEvent } from './api'
import { load, save } from './storage'

export type RepoState = 'indexing' | 'ready' | 'failed'

export interface Repo {
  url: string
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
}

interface RepoContextValue {
  repos: Repo[]
  active: Repo | null
  setActive: (url: string) => void
  index: (url: string) => Promise<Repo>
  remove: (url: string) => void
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

  async function index(url: string) {
    const { task_id, repo_url } = await startIndex(url)
    const repo: Repo = { url: repo_url, taskId: task_id, state: 'indexing', stage: 'PENDING', startedAt: Date.now() }
    setRepos((rs) => [repo, ...rs.filter((r) => r.url !== repo_url)])
    setActiveUrl(repo_url)
    return repo
  }

  function remove(url: string) {
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
