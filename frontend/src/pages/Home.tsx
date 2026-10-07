import { motion } from 'motion/react'
import { useMemo, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { STATUS_LABEL } from '../citations'
import CodeBlock from '../components/CodeBlock'
import CodeCity from '../components/CodeCity'
import { CitationChip, StatusMark, type CitationTarget } from '../components/CodeViewer'
import { navigate } from '../router'
import { sampleCity } from '../sampleCity'
import { repoName, useRepos } from '../state'

// Everything on this page comes from the sample repository the hero model is built from
// (sampleCity.ts): a small billing service. Nothing here is a real customer's code.

const STEPS = [
  { title: 'Plan', body: 'One model call works out what kind of question it is, picks out symbol names and writes search queries.' },
  { title: 'Search', body: 'Vector search and BM25 keyword search run side by side and merge by rank, so exact names still match.' },
  { title: 'Rerank', body: 'A small cross-encoder reads the question next to each candidate and keeps the eight that answer it.' },
  { title: 'Walk the graph', body: 'Callers, callees, base classes and overrides come from the call graph, with their code.' },
  { title: 'Ask for more', body: 'If something it needs is missing, the model names it and the code is fetched before it answers.' },
  { title: 'Answer and check', body: 'Every file and line it cites is checked against the code it was actually shown.' },
]

const SAMPLE_CODE = `def finalize(self, invoice: Invoice) -> Charge:
    """Charge the customer for a validated invoice."""
    self.validate(invoice)
    total = self._total(invoice)
    if total > invoice.limit:
        raise LimitExceeded(invoice.id, total)
    charge = self.gateway.charge(invoice.customer, total)
    invoice.mark_paid(charge.id)
    self.events.publish("invoice.paid", invoice.id)
    return charge`

const CITES: Record<string, CitationTarget> = {
  limit: { text: 'billing/service.py:46', filepath: 'billing/service.py', line: 46, end_line: 47, status: 'verified' },
  total: { text: 'billing/service.py:45', filepath: 'billing/service.py', line: 45, end_line: 45, status: 'verified' },
  checkout: { text: 'api/checkout.py:88', filepath: 'api/checkout.py', line: 88, end_line: 88, status: 'graph' },
}

const IMPACT = [
  { file: 'billing/service.py', items: [['InvoiceService.finalize', 1, 'calls'], ['InvoiceService.issue_refund', 1, 'calls']] },
  { file: 'api/checkout.py', items: [['checkout', 2, 'calls'], ['confirm', 2, 'calls']] },
  { file: 'reports/monthly.py', items: [['revenue_by_month', 3, 'calls']] },
] as const

function Hop({ n }: { n: number }) {
  return (
    <span
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-full text-[0.68rem] font-semibold tabular-nums',
        n === 1 && 'bg-thread text-white dark:text-[#0e2350]',
        n === 2 && 'bg-thread/55 text-white dark:text-[#0e2350]',
        n >= 3 && 'bg-thread/25 text-foreground',
      )}
      title={`${n} ${n === 1 ? 'call' : 'calls'} away`}
    >
      {n}
    </span>
  )
}

function StartForm({ className }: { className?: string }) {
  const { index } = useRepos()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return
    setBusy(true)
    try {
      const repo = await index(url.trim())
      toast(`Indexing ${repoName(repo.url)}`, { description: 'Follow each stage on the Index page.' })
      navigate('/index')
    } catch (err) {
      toast.error(`Couldn't start indexing: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className={cn('flex w-full max-w-xl flex-col gap-2 sm:flex-row', className)}>
      <label htmlFor="start-url" className="sr-only">Public GitHub repository URL</label>
      <input
        id="start-url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://github.com/pallets/click"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        className="h-11 min-w-0 flex-1 rounded-md border bg-sheet px-3.5 font-mono text-[0.85rem] placeholder:text-muted-foreground/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-thread"
      />
      <Button type="submit" size="lg" className="h-11" disabled={busy || !url.trim()}>
        {busy ? 'Starting…' : 'Index repository'}
      </Button>
    </form>
  )
}

export default function Home() {
  const city = useMemo(() => sampleCity(), [])
  const [viewing, setViewing] = useState<CitationTarget | null>(null)

  return (
    <>
      {/* Hero: the sample repository as a massing model, with the headline beside it. */}
      <section className="relative -mt-14 overflow-hidden pt-14">
        <div className="relative mx-auto grid min-h-[min(860px,calc(100svh-0px))] max-w-[1600px] grid-cols-1 lg:grid-cols-12">
          <CodeCity
            nodes={city.nodes}
            edges={city.edges}
            controls={false}
            tour
            framing={1.02}
            className="pointer-events-auto order-first h-[42svh] min-h-[300px] lg:absolute lg:inset-y-0 lg:right-[-3%] lg:left-[39%] lg:order-none lg:h-auto"
          />
          <div className="relative z-10 flex flex-col justify-center px-4 pb-14 sm:px-6 lg:col-span-6 lg:pb-24 xl:col-span-5 xl:pl-10">
            <motion.h1
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: [0.2, 0.7, 0.2, 1] }}
              className="display text-[clamp(3.4rem,8.4vw,8.25rem)]"
            >
              Ask your codebase. Get the file and the line.
            </motion.h1>
            <p className="mt-6 max-w-[46ch] text-[1.06rem] leading-relaxed text-muted-foreground">
              Index a Python, JavaScript or TypeScript repository. Every function and class becomes a block in a
              model you can walk, every call a thread between them, and every answer cites code you can open.
            </p>
            <div className="mt-8 flex flex-wrap gap-2.5">
              <Button size="lg" onClick={() => navigate('/index')}>Index a repository</Button>
              <Button size="lg" variant="outline" className="bg-sheet" onClick={() => document.getElementById('answer')?.scrollIntoView({ behavior: 'smooth' })}>
                See a checked answer
              </Button>
            </div>
          </div>
          <p className="relative z-10 px-4 pb-6 text-xs leading-relaxed text-muted-foreground sm:px-6 lg:absolute lg:bottom-6 lg:right-6 lg:max-w-sm lg:p-0 lg:text-right">
            A sample billing service as a model. Each block is a{' '}
            <Swatch kind="function" />function, <Swatch kind="method" />method or <Swatch kind="class" />class, as tall as its
            code is long, standing on its file. The <span className="font-medium text-thread">thread</span> is a call.
          </p>
        </div>
      </section>

      {/* The pipeline: a real sequence, so it's numbered. */}
      <section className="border-y bg-sheet">
        <div className="mx-auto max-w-[1600px] px-4 py-16 sm:px-6 xl:px-10">
          <div className="grid gap-10 lg:grid-cols-12">
            <div className="lg:col-span-4">
              <h2 className="display text-[clamp(2.2rem,4vw,3.4rem)]">How a question gets answered</h2>
              <p className="mt-4 max-w-[40ch] text-muted-foreground">
                The same six steps run for every question. On the Ask page each one opens up to show what it found.
              </p>
            </div>
            <ol className="grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:col-span-8 lg:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="relative border-t border-rule pt-4">
                  <span className="display block text-[2.6rem] leading-none tabular-nums">{i + 1}</span>
                  <h3 className="mt-2 font-semibold">{s.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* A checked answer next to the code it cites. */}
      <section id="answer" className="mx-auto max-w-[1600px] scroll-mt-20 px-4 py-20 sm:px-6 xl:px-10">
        <div className="grid items-start gap-10 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <h2 className="display text-[clamp(2.2rem,4vw,3.4rem)]">Every citation is checked against what the model saw</h2>
            <p className="mt-4 max-w-[46ch] text-muted-foreground">
              Click a citation to open the code with the line marked. Its sign says how far you can trust it.
            </p>
            <dl className="mt-8 space-y-3 text-sm">
              {(['verified', 'graph', 'wrong_line'] as const).map((s) => (
                <div key={s} className="flex gap-3">
                  <dt className="mt-0.5"><StatusMark status={s} className="size-4" /></dt>
                  <dd className="max-w-[44ch] text-muted-foreground">{STATUS_LABEL[s]}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="grid gap-4 lg:col-span-7">
            <figure className="rounded-xl border bg-sheet p-5 sm:p-6">
              <p className="text-sm font-medium">What happens when an invoice goes over its limit?</p>
              <div className="prose-answer mt-3">
                <p>
                  <code>InvoiceService.finalize</code> totals the invoice first <CitationChip target={CITES.total} onOpen={setViewing} />,
                  then raises <code>LimitExceeded</code> with the invoice id and the total when it's over <code>invoice.limit</code>{' '}
                  <CitationChip target={CITES.limit} onOpen={setViewing} />. Nothing is charged.
                </p>
                <p>
                  The error reaches <code>checkout</code>, which cancels the order <CitationChip target={CITES.checkout} onOpen={setViewing} />.
                </p>
              </div>
              <figcaption className="mt-4 border-t pt-3 text-xs text-muted-foreground">
                3 of 3 citations checked. A sample answer about the sample repository.
              </figcaption>
            </figure>

            <figure className={cn('overflow-hidden rounded-xl border bg-sheet transition-shadow', viewing && 'ring-2 ring-thread/40')}>
              <figcaption className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5">
                <span className="font-mono text-[0.78rem]">billing/service.py</span>
                <span className="text-xs text-muted-foreground">
                  {viewing ? `Showing ${viewing.text}` : 'Click a citation above'}
                </span>
              </figcaption>
              <CodeBlock
                code={SAMPLE_CODE}
                lang="python"
                startLine={42}
                mark={viewing && viewing.filepath === 'billing/service.py' ? [viewing.line, viewing.end_line] : [46, 47]}
                className="bg-background/40"
              />
              {viewing?.filepath === 'api/checkout.py' && (
                <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
                  <span className="font-mono text-foreground">api/checkout.py:88</span> came from the call graph: the location is
                  real, but its code wasn't in the model's context.
                </p>
              )}
            </figure>
          </div>
        </div>
      </section>

      {/* Impact and MCP: what the graph is good for outside of questions. */}
      <section className="border-t bg-sheet">
        <div className="mx-auto grid max-w-[1600px] gap-12 px-4 py-20 sm:px-6 lg:grid-cols-12 xl:px-10">
          <div className="lg:col-span-6">
            <h2 className="display text-[clamp(2rem,3.4vw,2.9rem)]">See what breaks before you change it</h2>
            <p className="mt-4 max-w-[48ch] text-muted-foreground">
              Pick a block and ask what depends on it: callers, subclasses and overrides, followed up to three calls back,
              grouped by file with the closest first.
            </p>
            <div className="mt-6 rounded-xl border bg-background/50 p-5">
              <p className="text-sm">
                Changing <code className="font-mono text-[0.85em]">InvoiceService._total</code> can affect{' '}
                <strong className="display text-[1.5rem] text-thread">5</strong> symbols in{' '}
                <strong className="display text-[1.5rem] text-thread">3</strong> files.
              </p>
              <div className="mt-4 space-y-4">
                {IMPACT.map((f) => (
                  <div key={f.file}>
                    <p className="font-mono text-[0.76rem] text-muted-foreground">{f.file}</p>
                    <ul className="mt-1.5 space-y-1.5">
                      {f.items.map(([name, hops, rel]) => (
                        <li key={name} className="flex items-center gap-2.5 text-sm">
                          <Hop n={hops} />
                          <span className="font-mono text-[0.8rem]">{name}</span>
                          <span className="ml-auto text-xs text-muted-foreground">{rel}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 lg:col-start-8">
            <h2 className="display text-[clamp(2rem,3.4vw,2.9rem)]">Use it from your editor</h2>
            <p className="mt-4 max-w-[46ch] text-muted-foreground">
              The same lookups are tools for coding agents over MCP: search, definitions, callers and callees, impact, and
              cited answers. Everything except answers is an exact graph lookup, with no model calls.
            </p>
            <div className="mt-6 overflow-hidden rounded-xl border bg-graphite text-[#e8ecf6] dark:bg-[#081a3f]">
              <p className="border-b border-white/10 px-4 py-2.5 text-xs text-white/60">Add it to Claude Code</p>
              <pre className="overflow-x-auto px-4 py-4 font-mono text-[0.8rem] leading-relaxed">
                <span className="text-white/45">$ </span>claude mcp add --transport http codebox http://localhost:8000/mcp
              </pre>
            </div>
            <ul className="mt-5 grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-[0.78rem] text-muted-foreground">
              {['search_code', 'find_definition', 'get_symbol_code', 'get_code_at', 'find_callers', 'find_callees', 'impact_of', 'ask_codebase'].map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1600px] px-4 py-24 sm:px-6 xl:px-10">
        <h2 className="display max-w-[16ch] text-[clamp(2.6rem,5.4vw,4.6rem)]">Start with a repository you know well</h2>
        <p className="mt-4 max-w-[52ch] text-muted-foreground">
          You'll be able to tell straight away whether the answers are right. Public GitHub repositories only.
        </p>
        <StartForm className="mt-8" />
      </section>

      <footer className="border-t">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-1 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:px-6 xl:px-10">
          <span>Codebase RAG</span>
          <span>FastAPI, Celery, LangGraph, Neo4j, Qdrant, RediSearch and three.js</span>
        </div>
      </footer>
    </>
  )
}

function Swatch({ kind }: { kind: 'function' | 'method' | 'class' }) {
  return (
    <span
      aria-hidden
      className="mr-1 inline-block size-2.5 translate-y-px rounded-[2px] border border-graphite/30"
      style={{ background: `var(--kind-${kind})` }}
    />
  )
}
