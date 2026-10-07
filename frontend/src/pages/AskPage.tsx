import { motion } from 'motion/react'
import { ArrowUp, ListTree, RotateCcw, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ask, type ChatTurn } from '../api'
import { CITATION_ONLY, citationSummary, findCitation, linkifyCitations } from '../citations'
import CodeViewer, { CitationChip, targetFromText, type CitationTarget } from '../components/CodeViewer'
import EmptyState from '../components/EmptyState'
import PipelineInspector from '../components/PipelineInspector'
import { repoName, useRepos, type Message } from '../state'
import { load, save } from '../storage'

// Follow-up context sent with each question: the most recent finished messages.
const HISTORY_MESSAGES = 6
const HISTORY_CHARS = 4000

function historyFrom(messages: Message[]): ChatTurn[] {
  return messages
    .filter((m) => !m.pending && !m.error && m.content)
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, HISTORY_CHARS) }))
}

const SUGGESTIONS = [
  'What is the main entry point, and what does it call?',
  'Which classes inherit from each other, and why?',
  'Where can errors be raised during the main flow?',
  'Give me a short tour of how the code is organised.',
]

const uid = () => Math.random().toString(36).slice(2)

function Answer({ msg, onCite }: { msg: Message; onCite: (t: CitationTarget) => void }) {
  const summary = citationSummary(msg.citations)
  return (
    <div>
      {msg.status === 'fallback_model' && (
        <p className="mb-2 text-xs text-muted-foreground">Answered by the fallback model, because the main model was rate-limited.</p>
      )}
      <div className={cn('prose-answer', (msg.error || msg.status === 'degraded') && 'text-check')}>
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
        {msg.pending && msg.content && <span aria-hidden className="ml-0.5 inline-block h-[1.05em] w-[0.5ch] translate-y-[0.15em] animate-pulse bg-thread" />}
      </div>
      {!msg.pending && summary.total > 0 && (
        <p className={cn('mt-3 text-xs', summary.unsupported ? 'text-check' : 'text-muted-foreground')}>
          {summary.unsupported
            ? `${summary.unsupported} of ${summary.total} ${summary.total === 1 ? 'citation isn’t' : 'citations aren’t'} backed by the code the model saw. Check ${summary.unsupported === 1 ? 'it' : 'those'} before relying on ${summary.unsupported === 1 ? 'it' : 'them'}.`
            : summary.total === 1
              ? 'Its citation is backed by the code the model saw or by the call graph.'
              : `All ${summary.total} citations are backed by the code the model saw or by the call graph.`}
        </p>
      )}
    </div>
  )
}

function Thinking({ msg }: { msg: Message }) {
  const last = msg.trace?.at(-1)?.node
  const label: Record<string, string> = {
    query_planner: 'Planning the search',
    retrieval_router: 'Choosing a route',
    embed_queries: 'Embedding the queries',
    retrieve: 'Searching',
    rerank: 'Reranking',
    graph_search: 'Writing the answer',
    fetch_more: 'Writing the answer with the code it asked for',
  }
  return (
    <p className="flex items-center gap-2.5 text-sm text-muted-foreground" aria-live="polite">
      <span aria-hidden className="size-2 animate-pulse rounded-full bg-thread shadow-[0_0_8px_var(--thread)]" />
      {last ? label[last] ?? 'Working' : 'Starting'}…
    </p>
  )
}

export default function AskPage() {
  const { active, chats, updateChat } = useRepos()
  const messages = active ? chats[active.url] ?? [] : []
  const [input, setInput] = useState(() => {
    const draft = load<string>('ask-draft', '')
    if (draft) save('ask-draft', '')
    return draft
  })
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewing, setViewing] = useState<CitationTarget | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  // Ask-for-more: the model may request missing code once (one more model call when it does).
  const [allowFollowup, setAllowFollowup] = useState<boolean>(() => load('ask-followup', true))
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const lastContent = messages.at(-1)?.content
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, lastContent])
  useEffect(() => () => abortRef.current?.abort(), [])

  if (!active || active.state !== 'ready') {
    return (
      <EmptyState
        title={!active ? 'Pick a repository first' : active.state === 'indexing' ? 'Still being built' : 'Indexing failed'}
        body="Questions are answered from an indexed repository's code and call graph."
        action={{ label: 'Go to Index', to: '/index' }}
      />
    )
  }
  const repoUrl = active.url
  const assistant = messages.filter((m) => m.role === 'assistant')
  const selected = assistant.find((m) => m.id === selectedId) ?? assistant.at(-1) ?? null
  const selectedQuestion = selected ? messages[messages.findIndex((m) => m.id === selected.id) - 1]?.content : undefined

  async function send(question: string) {
    const q = question.trim()
    if (q.length < 3 || busy) return
    const history = historyFrom(messages)
    const reply: Message = { id: uid(), role: 'assistant', content: '', pending: true, trace: [], startedAt: Date.now() }
    const patch = (fn: (m: Message) => Message) => updateChat(repoUrl, (ms) => ms.map((m) => (m.id === reply.id ? fn(m) : m)))

    updateChat(repoUrl, (ms) => [...ms, { id: uid(), role: 'user', content: q }, reply])
    setSelectedId(reply.id)
    setInput('')
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      let text = ''
      await ask(q, repoUrl, { history, allowFollowup }, {
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
      patch((m) => ({ ...m, pending: false, finishedAt: Date.now(), content: text || 'No answer came back.', error: !text }))
    } catch (e) {
      const stopped = (e as Error).name === 'AbortError'
      patch((m) => ({
        ...m,
        pending: false,
        error: !stopped,
        finishedAt: Date.now(),
        content: stopped ? (m.content || 'Stopped.') : `The request failed: ${(e as Error).message}`,
      }))
    } finally {
      setBusy(false)
      abortRef.current = null
      inputRef.current?.focus()
    }
  }

  const turns: { q: Message; a?: Message }[] = []
  messages.forEach((m) => {
    if (m.role === 'user') turns.push({ q: m })
    else if (turns.length) turns[turns.length - 1].a = m
  })

  return (
    <div className="mx-auto grid h-[calc(100svh-3.5rem)] max-w-[1600px] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_25rem] xl:grid-cols-[minmax(0,1fr)_28rem]">
      <section className="flex min-h-0 flex-col" aria-label="Conversation">
        <header className="flex min-h-12 items-center gap-3 border-b px-4 py-2 sm:px-8">
          <h1 className="min-w-0 truncate font-mono text-[0.85rem] font-medium">{repoName(repoUrl)}</h1>
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-muted-foreground"
              disabled={busy}
              onClick={() => { updateChat(repoUrl, () => []); setSelectedId(null) }}
            >
              <RotateCcw /> New conversation
            </Button>
          )}
        </header>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-8">
          {turns.length === 0 ? (
            <div className="mx-auto max-w-[68ch] py-16">
              <h2 className="display text-[clamp(2.4rem,5vw,3.6rem)]">Ask about {repoName(repoUrl).split('/')[1] ?? repoName(repoUrl)}</h2>
              <p className="mt-3 max-w-[56ch] text-muted-foreground">
                Ask in plain English, and follow up. Every answer cites the file and line it comes from, and each citation is
                checked against the code the model was shown.
              </p>
              <ul className="mt-8 divide-y border-y">
                {SUGGESTIONS.map((s) => (
                  <li key={s}>
                    <button onClick={() => send(s)} className="group flex w-full items-center justify-between gap-4 py-3 text-left text-[0.95rem]">
                      <span>{s}</span>
                      <ArrowUp className="size-4 shrink-0 rotate-45 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ol className="mx-auto max-w-[72ch] py-8">
              {turns.map(({ q, a }) => {
                const isSelected = a && selected?.id === a.id
                return (
                  <motion.li
                    key={q.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className="border-b py-7 first:pt-2 last:border-b-0"
                  >
                    <p className="text-[1.02rem] font-semibold leading-snug">{q.content}</p>
                    {a && (
                      <div
                        className={cn(
                          'relative mt-3 border-l-2 pl-4 transition-colors',
                          isSelected ? 'border-thread' : 'border-transparent hover:border-rule',
                        )}
                        onClick={() => setSelectedId(a.id)}
                      >
                        {a.pending && !a.content ? <Thinking msg={a} /> : <Answer msg={a} onCite={setViewing} />}
                        <div className="mt-3 lg:hidden">
                          <Button variant="outline" size="xs" className="bg-sheet" onClick={(e) => { e.stopPropagation(); setSelectedId(a.id); setInspectorOpen(true) }}>
                            <ListTree /> How this was answered
                          </Button>
                        </div>
                      </div>
                    )}
                  </motion.li>
                )
              })}
            </ol>
          )}
        </div>

        <form className="border-t bg-background px-4 pb-4 pt-3 sm:px-8" onSubmit={(e) => { e.preventDefault(); send(input) }}>
          <div className="mx-auto max-w-[72ch]">
            <div className="flex items-end gap-2 rounded-xl border bg-sheet p-2 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-thread">
              <label htmlFor="question" className="sr-only">Question</label>
              <textarea
                id="question"
                ref={inputRef}
                value={input}
                placeholder={turns.length ? 'Ask a follow-up' : `Ask about ${repoName(repoUrl)}`}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send(input)
                  }
                }}
                rows={1}
                className="max-h-44 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[0.95rem] outline-none [field-sizing:content] placeholder:text-muted-foreground/70 focus-visible:outline-none"
              />
              {busy ? (
                <Button type="button" size="icon" variant="outline" aria-label="Stop" onClick={() => abortRef.current?.abort()}>
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button type="submit" size="icon" aria-label="Ask" disabled={input.trim().length < 3}>
                  <ArrowUp />
                </Button>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2.5 px-1 text-xs text-muted-foreground">
              <Switch id="followup" checked={allowFollowup} onCheckedChange={(v) => { setAllowFollowup(v); save('ask-followup', v) }} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <label htmlFor="followup" className="cursor-pointer">
                    {allowFollowup ? 'Let the model fetch code it finds missing' : 'Answer from the first search only'}
                  </label>
                </TooltipTrigger>
                <TooltipContent className="max-w-64">
                  If the context is missing code it needs, the model can ask for it once before answering. That costs one more model call when it happens.
                </TooltipContent>
              </Tooltip>
              <span className="ml-auto hidden sm:inline">Enter to send, Shift+Enter for a new line</span>
            </div>
          </div>
        </form>
      </section>

      <aside className="hidden min-h-0 overflow-y-auto border-l bg-sheet lg:block" aria-label="How this answer was built">
        <h2 className="sticky top-0 z-10 border-b bg-sheet/95 px-4 py-3 text-sm font-semibold backdrop-blur">How this answer was built</h2>
        <PipelineInspector msg={selected} question={selectedQuestion} />
      </aside>

      <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto bg-sheet p-0 sm:max-w-md">
          <SheetTitle className="border-b px-4 py-3 text-sm">How this answer was built</SheetTitle>
          <PipelineInspector msg={selected} question={selectedQuestion} />
        </SheetContent>
      </Sheet>

      <CodeViewer repoUrl={repoUrl} target={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}
