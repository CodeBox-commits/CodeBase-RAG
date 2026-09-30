import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ask, getStatus, startIndex, type IndexResult } from './api'
import { load, save } from './storage'

type RepoState = 'indexing' | 'ready' | 'failed'

interface Repo {
  url: string
  taskId?: string
  state: RepoState
  step?: string
  result?: IndexResult
  error?: string
  indexedAt?: number
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  error?: boolean
}

const STEPS: Record<string, string> = {
  PENDING: 'Queued',
  CLONING: 'Cloning repository',
  PARSING: 'Parsing & embedding code',
  LINKING: 'Linking call graph',
}

const SUGGESTIONS = [
  'Give me a high-level overview of how this codebase is structured.',
  'What is the main entry point and what does it call?',
  'Which classes inherit from each other?',
  'Where could errors be raised during the main flow?',
]

const THINKING = [
  'Analysing the question…',
  'Searching code by meaning and keywords…',
  'Walking the call graph…',
  'Writing the answer…',
]

function repoName(url: string) {
  const parts = url.replace(/\/+$/, '').split('/')
  return parts.slice(-2).join('/')
}

const uid = () => Math.random().toString(36).slice(2)

export default function Workspace() {
  const [repos, setRepos] = useState<Repo[]>(() => load('repos', []))
  const [active, setActive] = useState<string | null>(() => load('active', null))
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
  const [urlInput, setUrlInput] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => { save('repos', repos) }, [repos])
  useEffect(() => { save('active', active) }, [active])
  useEffect(() => { save('chats', chats) }, [chats])

  const updateRepo = (url: string, patch: Partial<Repo>) =>
    setRepos((rs) => rs.map((r) => (r.url === url ? { ...r, ...patch } : r)))

  // Poll every in-flight indexing task.
  const indexing = repos.filter((r) => r.state === 'indexing' && r.taskId)
  const indexingKey = indexing.map((r) => r.taskId).join(',')
  useEffect(() => {
    if (!indexingKey) return
    const tick = async () => {
      for (const repo of indexing) {
        try {
          const s = await getStatus(repo.taskId!)
          if (s.status === 'SUCCESS') {
            updateRepo(repo.url, { state: 'ready', result: s.result, step: undefined, indexedAt: Date.now() })
          } else if (s.status === 'FAILURE') {
            updateRepo(repo.url, { state: 'failed', error: s.error, step: undefined })
          } else {
            updateRepo(repo.url, { step: STEPS[s.status] ?? s.message ?? s.status })
          }
        } catch {
          /* transient; next tick retries */
        }
      }
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexingKey])

  async function submitIndex(url: string) {
    setFormError('')
    setSubmitting(true)
    try {
      const { task_id, repo_url } = await startIndex(url)
      setRepos((rs) => [
        { url: repo_url, taskId: task_id, state: 'indexing', step: 'Queued' },
        ...rs.filter((r) => r.url !== repo_url),
      ])
      setActive(repo_url)
      setUrlInput('')
      setSidebarOpen(false)
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  function removeRepo(url: string) {
    setRepos((rs) => rs.filter((r) => r.url !== url))
    setChats(({ [url]: _, ...rest }) => rest)
    if (active === url) setActive(null)
  }

  const activeRepo = repos.find((r) => r.url === active) ?? null

  return (
    <div className="app">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="logo" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18">
              <circle cx="6" cy="6" r="2.4" />
              <circle cx="18" cy="8" r="2.4" />
              <circle cx="10" cy="18" r="2.4" />
              <path d="M6 6 L18 8 L10 18 Z" fill="none" strokeWidth="1.4" />
            </svg>
          </div>
          <div>
            <div className="brand-title">Codebase RAG</div>
            <div className="brand-sub">AST · Graph · Vector search</div>
          </div>
        </div>

        <form
          className="index-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (urlInput.trim()) submitIndex(urlInput.trim())
          }}
        >
          <label htmlFor="repo-url">Index a Python repository</label>
          <input
            id="repo-url"
            type="url"
            placeholder="https://github.com/owner/repo"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            autoComplete="off"
          />
          <button type="submit" className="primary" disabled={submitting || !urlInput.trim()}>
            {submitting ? 'Submitting…' : 'Index repository'}
          </button>
          {formError && <p className="form-error">{formError}</p>}
        </form>

        <div className="repo-list-title">Repositories</div>
        {repos.length === 0 && <p className="muted small">Nothing indexed yet.</p>}
        <ul className="repo-list">
          {repos.map((r) => (
            <li key={r.url}>
              <button
                className={`repo ${r.url === active ? 'active' : ''}`}
                onClick={() => {
                  setActive(r.url)
                  setSidebarOpen(false)
                }}
              >
                <span className={`dot ${r.state}`} aria-hidden />
                <span className="repo-text">
                  <span className="repo-name">{repoName(r.url)}</span>
                  <span className="repo-meta">
                    {r.state === 'indexing' && (r.step ?? 'Working…')}
                    {r.state === 'ready' &&
                      `${r.result?.symbols ?? '?'} symbols · ${r.result?.call_edges ?? '?'} call edges`}
                    {r.state === 'failed' && 'Indexing failed'}
                  </span>
                </span>
              </button>
              <button className="icon" title="Remove from list" onClick={() => removeRepo(r.url)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="icon menu" onClick={() => setSidebarOpen((o) => !o)} aria-label="Toggle repositories">
            ☰
          </button>
          {activeRepo ? (
            <div className="topbar-repo">
              <span className={`dot ${activeRepo.state}`} aria-hidden />
              <a href={activeRepo.url} target="_blank" rel="noreferrer">
                {repoName(activeRepo.url)}
              </a>
              {activeRepo.state === 'ready' && activeRepo.result && (
                <span className="chips">
                  <span className="chip">{activeRepo.result.parsed_files} files</span>
                  <span className="chip">{activeRepo.result.symbols} symbols</span>
                  <span className="chip">{activeRepo.result.call_edges} call edges</span>
                </span>
              )}
              {activeRepo.state === 'ready' && (
                <button className="ghost small-btn" onClick={() => submitIndex(activeRepo.url)}>
                  Re-index
                </button>
              )}
            </div>
          ) : (
            <div className="muted">No repository selected</div>
          )}
        </header>

        {activeRepo ? (
          <Chat
            key={activeRepo.url}
            repo={activeRepo}
            messages={chats[activeRepo.url] ?? []}
            setMessages={(fn) =>
              setChats((c) => ({ ...c, [activeRepo.url]: fn(c[activeRepo.url] ?? []) }))
            }
            onRetryIndex={() => submitIndex(activeRepo.url)}
          />
        ) : (
          <Welcome />
        )}
      </main>
    </div>
  )
}

function Welcome() {
  return (
    <div className="welcome">
      <h1>Ask questions about any Python codebase</h1>
      <p className="muted">
        Repositories are parsed into functions and classes, embedded for semantic search, indexed for keyword
        search, and linked into a call graph. Answers cite the files and lines they come from.
      </p>
      <ol className="how">
        <li>
          <strong>Index</strong> a public Git URL from the sidebar.
        </li>
        <li>
          <strong>Wait</strong> while it clones, parses and links the call graph.
        </li>
        <li>
          <strong>Ask</strong> about definitions, call flows, dependencies or architecture.
        </li>
      </ol>
    </div>
  )
}

function Chat({
  repo,
  messages,
  setMessages,
  onRetryIndex,
}: {
  repo: Repo
  messages: Message[]
  setMessages: (fn: (m: Message[]) => Message[]) => void
  onRetryIndex: () => void
}) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    // Scroll only the message list; scrollIntoView would also scroll the surrounding page.
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages])
  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    if (!busy) return
    setPhase(0)
    const id = setInterval(() => setPhase((p) => Math.min(p + 1, THINKING.length - 1)), 2500)
    return () => clearInterval(id)
  }, [busy])

  async function send(question: string) {
    const q = question.trim()
    if (q.length < 3 || busy) return
    const userMsg: Message = { id: uid(), role: 'user', content: q }
    const reply: Message = { id: uid(), role: 'assistant', content: '', pending: true }
    setMessages((m) => [...m, userMsg, reply])
    setInput('')
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    const patch = (p: Partial<Message>) =>
      setMessages((m) => m.map((x) => (x.id === reply.id ? { ...x, ...p } : x)))
    try {
      let text = ''
      await ask(q, repo.url, (t) => {
        text += t
        patch({ content: text, pending: false })
      }, controller.signal)
      if (!text) patch({ content: 'No answer was returned.', pending: false, error: true })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        patch({ content: `Request failed: ${(e as Error).message}`, pending: false, error: true })
      }
    } finally {
      setBusy(false)
    }
  }

  if (repo.state === 'indexing') {
    const order = Object.values(STEPS)
    const current = Math.max(0, order.indexOf(repo.step ?? ''))
    return (
      <div className="center-panel">
        <div className="spinner" aria-hidden />
        <h2>Indexing {repoName(repo.url)}</h2>
        <ol className="steps">
          {order.map((s, i) => (
            <li key={s} className={i < current ? 'done' : i === current ? 'current' : ''}>
              {s}
            </li>
          ))}
        </ol>
        <p className="muted small">Large repositories can take a few minutes.</p>
      </div>
    )
  }

  if (repo.state === 'failed') {
    return (
      <div className="center-panel">
        <h2>Indexing failed</h2>
        <pre className="error-box">{repo.error}</pre>
        <button className="primary" onClick={onRetryIndex}>
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="chat">
      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="suggestions">
            <p className="muted">Try asking</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggestion" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role} ${m.error ? 'error' : ''}`}>
            {m.pending ? (
              <div className="thinking">
                <span className="pulse" aria-hidden />
                {THINKING[phase]}
              </div>
            ) : m.role === 'assistant' ? (
              <div className="md">
                <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown>
              </div>
            ) : (
              m.content
            )}
          </div>
        ))}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
      >
        <textarea
          value={input}
          placeholder={`Ask about ${repoName(repo.url)}…`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(input)
            }
          }}
          rows={1}
        />
        <button type="submit" className="primary" disabled={busy || input.trim().length < 3}>
          {busy ? '…' : 'Ask'}
        </button>
      </form>
      <p className="hint">Enter to send · Shift+Enter for a new line</p>
    </div>
  )
}
