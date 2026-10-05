import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ask, type ChatTurn } from '../api'
import { CITATION_ONLY, citationSummary, findCitation, linkifyCitations } from '../citations'
import CodeViewer, { CitationChip, targetFromText, type CitationTarget } from '../components/CodeViewer'
import PipelineInspector from '../components/PipelineInspector'
import MiniCity from '../components/MiniCity'
import { navigate } from '../router'
import { repoName, useRepos, type Message } from '../state'

// Follow-up context sent with each question: the most recent finished messages.
const HISTORY_MESSAGES = 6
const HISTORY_CHARS = 4000

function historyFrom(messages: Message[]): ChatTurn[] {
  return messages
    .filter((m) => !m.pending && !m.error && m.content)
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, HISTORY_CHARS) }))
}

function Answer({ msg, onCite }: { msg: Message; onCite: (t: CitationTarget) => void }) {
  const summary = citationSummary(msg.citations)
  return (
    <>
      {msg.status === 'fallback_model' && <p className="answer-note">Answered by the fallback model: the main model was rate-limited.</p>}
      <div className="md">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children }) {
              const text = String(children)
              if (!className && CITATION_ONLY.test(text.trim())) {
                return <CitationChip target={targetFromText(text, findCitation(text, msg.citations))} onOpen={onCite} />
              }
              return <code className={className}>{children}</code>
            },
          }}
        >
          {linkifyCitations(msg.content)}
        </Markdown>
      </div>
      {!msg.pending && summary.total > 0 && (
        <p className={`cite-summary ${summary.unsupported ? 'warn' : ''}`}>
          {summary.supported} of {summary.total} citations checked against the code the model saw
          {summary.unsupported > 0 && <> · <b>{summary.unsupported} unverified</b></>}
        </p>
      )}
    </>
  )
}

const SUGGESTIONS = [
  'Give me a high-level overview of how this codebase is structured.',
  'What is the main entry point and what does it call?',
  'Which classes inherit from each other?',
  'Where could errors be raised during the main flow?',
]

const MINI_STEPS = ['query_planner', 'retrieval_router', 'embed_queries', 'retrieve', 'rerank', 'graph_search'] as const

const uid = () => Math.random().toString(36).slice(2)

function MiniPipeline({ msg }: { msg: Message }) {
  const seen = new Set((msg.trace ?? []).map((e) => e.node))
  const firstPending = MINI_STEPS.findIndex((s) => !seen.has(s))
  return (
    <div className="mini-pipe" aria-hidden>
      {MINI_STEPS.map((s, i) => {
        const cls = seen.has(s) ? 'done' : i === firstPending ? 'active' : ''
        return <span key={s} className={cls} />
      })}
      <span className={!msg.pending ? 'done' : firstPending === -1 ? 'active' : ''} />
    </div>
  )
}

export default function AskPage() {
  const { active, chats, updateChat } = useRepos()
  const messages = active ? chats[active.url] ?? [] : []
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewing, setViewing] = useState<CitationTarget | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, messages.at(-1)?.content])
  useEffect(() => () => abortRef.current?.abort(), [])

  const assistant = messages.filter((m) => m.role === 'assistant')
  const selected = assistant.find((m) => m.id === selectedId) ?? assistant.at(-1) ?? null
  const selectedQuestion = selected ? messages[messages.findIndex((m) => m.id === selected.id) - 1]?.content : undefined

  if (!active || active.state !== 'ready') {
    return (
      <div className="page">
        <div className="empty-state rise">
          <MiniCity />
          <h2>{!active ? 'Pick a repository first' : active.state === 'indexing' ? 'Still indexing…' : 'Indexing failed'}</h2>
          <p className="muted">Questions are answered from an indexed repository's code and call graph.</p>
          <button className="btn btn-primary" onClick={() => navigate('/index')}>Go to Index</button>
        </div>
      </div>
    )
  }
  const repoUrl = active.url

  async function send(question: string) {
    const q = question.trim()
    if (q.length < 3 || busy) return
    const history = historyFrom(messages)
    const reply: Message = { id: uid(), role: 'assistant', content: '', pending: true, trace: [], startedAt: Date.now() }
    const patch = (fn: (m: Message) => Message) =>
      updateChat(repoUrl, (ms) => ms.map((m) => (m.id === reply.id ? fn(m) : m)))

    updateChat(repoUrl, (ms) => [...ms, { id: uid(), role: 'user', content: q }, reply])
    setSelectedId(reply.id)
    setInput('')
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      let text = ''
      await ask(q, repoUrl, history, {
        onStep: (e) => patch((m) => ({ ...m, trace: [...(m.trace ?? []), e] })),
        onToken: (t) => {
          text += t
          patch((m) => ({ ...m, content: text }))
        },
        onAnswer: (a) => {
          // The checked final answer replaces the streamed text (a fallback may have taken over).
          text = a.content
          patch((m) => ({ ...m, content: a.content, citations: a.citations, status: a.status }))
        },
      }, controller.signal)
      patch((m) => ({
        ...m,
        pending: false,
        finishedAt: Date.now(),
        content: text || 'No answer was returned.',
        error: !text,
      }))
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        patch((m) => ({ ...m, pending: false, error: true, finishedAt: Date.now(), content: `Request failed: ${(e as Error).message}` }))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page ask-page">
      <section className="panel chat-panel rise">
        <header className="panel-head">
          <h2>{repoName(repoUrl)}</h2>
          {messages.length > 0 && (
            <button className="ghost small-btn" onClick={() => { updateChat(repoUrl, () => []); setSelectedId(null) }}>Clear</button>
          )}
        </header>

        <div className="messages" ref={listRef}>
          {messages.length === 0 && (
            <div className="suggestions">
              <p className="muted">Some questions to start with</p>
              {SUGGESTIONS.map((s, i) => (
                <button key={s} className="suggestion" style={{ animationDelay: `${i * 80}ms` }} onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          )}
          {messages.map((m) => (
            m.role === 'user' ? (
              <div key={m.id} className="msg user">{m.content}</div>
            ) : (
              <div
                key={m.id}
                className={`msg assistant ${m.error ? 'error' : ''} ${m.status === 'degraded' ? 'degraded' : ''} ${selected?.id === m.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(m.id)}
              >
                <MiniPipeline msg={m} />
                {m.pending && !m.content ? (
                  <div className="thinking"><span className="pulse" />Running the pipeline…</div>
                ) : (
                  <Answer msg={m} onCite={setViewing} />
                )}
              </div>
            )
          ))}
        </div>

        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input) }}>
          <textarea
            value={input}
            placeholder={`Ask about ${repoName(repoUrl)}…`}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(input)
              }
            }}
            rows={1}
            aria-label="Question"
          />
          <button type="submit" className="btn btn-primary" disabled={busy || input.trim().length < 3}>
            {busy ? <span className="spinner tiny" /> : 'Ask'}
          </button>
        </form>
      </section>

      <aside className="panel inspector-panel rise" style={{ animationDelay: '120ms' }}>
        <header className="panel-head">
          <h2>How this answer was built</h2>
        </header>
        <PipelineInspector msg={selected} question={selectedQuestion} />
      </aside>
      {viewing && <CodeViewer repoUrl={repoUrl} target={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}
