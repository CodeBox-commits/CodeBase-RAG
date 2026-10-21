import { useMemo, useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import CodeCity from '../components/CodeCity'
import { Magnetic, RevealText, Rise, RiseGroup } from '../components/motion'
import AnswerStory from '../home/AnswerStory'
import PipelineStory from '../home/PipelineStory'
import QualityBand from '../home/QualityBand'
import { gsap, NAV, ScrollTrigger, useReveal, useScrollScene, useStoryMode } from '../home/useScrollStory'
import { navigate } from '../router'
import { sampleCity } from '../sampleCity'
import { repoName, useRepos } from '../state'

// Everything on this page comes from the sample repository the hero city is built from
// (sampleCity.ts): a small billing service. Nothing here is a real customer's code.

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
        n === 1 && 'bg-thread text-[#160936]',
        n === 2 && 'bg-thread/55 text-[#160936]',
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
  const page = useRef<HTMLDivElement>(null)
  const story = useStoryMode()
  useReveal(page)

  // The page as a stack of cards: each story card slides up over the one before, which shrinks, dims
  // and rounds off into the distance underneath it. Wide screens with motion allowed only.
  useScrollScene(page, (root) => {
    const coming = (layer: string) => root.querySelector<HTMLElement>(`[data-over="${layer}"]`)
    root.querySelectorAll<HTMLElement>('[data-layer]').forEach((layer) => {
      const over = coming(layer.dataset.layer!)
      if (!over) return
      gsap.to(layer, {
        scale: 0.9, opacity: 0.3, borderRadius: 28, ease: 'none',
        scrollTrigger: { trigger: over, start: 'top bottom', end: `top top+=${NAV}`, scrub: true },
      })
    })
    const over = coming('hero')
    // The headline lifts away faster than the city behind it.
    gsap.to(root.querySelector('[data-hero-copy]'), {
      y: -180, opacity: 0, ease: 'none',
      scrollTrigger: { trigger: over, start: 'top bottom', end: 'top 35%', scrub: true },
    })
    // Once the pipeline card covers the hero, take the hero out so the 3D city stops drawing.
    const hero = root.querySelector('[data-layer="hero"]')
    ScrollTrigger.create({
      trigger: over,
      start: `top top+=${NAV}`,
      onEnter: () => gsap.set(hero, { display: 'none' }),
      onLeaveBack: () => gsap.set(hero, { clearProps: 'display' }),
    })
  }, story)

  return (
    <div ref={page}>
      {/* Hero: the sample repository as a neon city, with the headline beside it. In story mode it stays
          put while the pipeline card slides up over it. */}
      <div className="-mt-14" style={story ? { height: 'calc(200svh - 3.5rem)' } : undefined}>
      <section data-layer="hero" className={cn('relative overflow-hidden pt-14', story && 'sticky top-0 h-svh')}>
        <div className="relative mx-auto grid min-h-[min(860px,calc(100svh-0px))] max-w-[1600px] grid-cols-1 lg:grid-cols-12">
          <CodeCity
            nodes={city.nodes}
            edges={city.edges}
            controls={false}
            tour
            offsetX={0.2}
            className="pointer-events-auto order-first h-[42svh] min-h-[300px] lg:absolute lg:inset-0 lg:order-none lg:h-auto"
          />
          {/* Keeps the copy legible where towers run behind it. */}
          <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 hidden w-[58%] bg-gradient-to-r from-background via-background/80 to-transparent lg:block" />
          <div data-hero-copy className="relative z-10 flex flex-col justify-center px-4 pb-14 sm:px-6 lg:col-span-6 lg:pb-24 xl:col-span-5 xl:pl-10">
            <RevealText text="Ask your codebase. Get the file and the line." className="display text-[clamp(2.6rem,5vw,4.6rem)]" />
            <RiseGroup delay={0.55}>
              <Rise as="div">
                <p className="mt-6 max-w-[46ch] text-[1.06rem] leading-relaxed text-muted-foreground">
                  Index a Python, JavaScript or TypeScript repository. Every function and class becomes a glowing tower
                  in a city you can walk, every call a light arc between them, and every answer cites code you can open.
                </p>
              </Rise>
              <Rise className="mt-8 flex flex-wrap gap-2.5">
                <Magnetic><Button size="lg" onClick={() => navigate('/index')}>Index a repository</Button></Magnetic>
                <Button size="lg" variant="outline" className="bg-sheet" onClick={() => document.getElementById('answer')?.scrollIntoView({ behavior: 'smooth' })}>
                  See a checked answer
                </Button>
              </Rise>
            </RiseGroup>
          </div>
          <p className="relative z-10 px-4 pb-6 text-xs leading-relaxed text-muted-foreground sm:px-6 lg:absolute lg:bottom-6 lg:right-6 lg:max-w-sm lg:p-0 lg:text-right">
            A sample billing service as a city. Each tower is a{' '}
            <Swatch kind="function" />function, <Swatch kind="method" />method or <Swatch kind="class" />class, as tall as its
            code is long, standing on its file. Lit <span className="font-medium text-thread">arcs</span> are calls.
          </p>
        </div>
      </section>
      </div>

      {/* The pipeline and the checked answer play out as you scroll (src/home). */}
      <PipelineStory />
      <AnswerStory />
      <QualityBand />

      {/* Impact and MCP: what the graph is good for outside of questions. */}
      <section className="relative z-30 border-t bg-background">
        <div className="mx-auto grid max-w-[1600px] gap-12 px-4 py-20 sm:px-6 lg:grid-cols-12 xl:px-10">
          <div data-reveal className="lg:col-span-6">
            <h2 className="display text-[clamp(1.6rem,2.6vw,2.2rem)]">See what breaks before you change it</h2>
            <p className="mt-4 max-w-[48ch] text-muted-foreground">
              Pick a tower and ask what depends on it: callers, subclasses and overrides, followed up to three calls back,
              grouped by file with the closest first.
            </p>
            <div className="spotlight relative mt-6 rounded-xl border bg-background/50 p-5">
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

          <div data-reveal className="lg:col-span-5 lg:col-start-8">
            <h2 className="display text-[clamp(1.6rem,2.6vw,2.2rem)]">Use it from your editor</h2>
            <p className="mt-4 max-w-[46ch] text-muted-foreground">
              The same lookups are tools for coding agents over MCP: search, definitions, callers and callees, impact, and
              cited answers. Everything except answers is an exact graph lookup, with no model calls.
            </p>
            <div className="spotlight relative mt-6 overflow-hidden rounded-xl border bg-[#09080e] text-[#e9e8f0]">
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

      <section className="relative z-30 bg-background">
        <div data-reveal className="mx-auto max-w-[1600px] px-4 py-24 sm:px-6 xl:px-10">
          <h2 className="display max-w-[16ch] text-[clamp(2rem,4vw,3.2rem)]">Start with a repository you know well</h2>
          <p className="mt-4 max-w-[52ch] text-muted-foreground">
            You'll be able to tell straight away whether the answers are right. Public GitHub repositories only.
          </p>
          <StartForm className="mt-8" />
        </div>
      </section>

      <footer className="relative z-30 border-t bg-background">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-1 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:px-6 xl:px-10">
          <span>Codebase RAG</span>
          <span>FastAPI, Celery, LangGraph, Neo4j, Qdrant, RediSearch and three.js</span>
        </div>
      </footer>
    </div>
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
