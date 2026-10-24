import { ArrowUpRight } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { gsap, MOTION_QUERY, NAV, useScrollScene, useStoryMode } from './useScrollStory'

// From the evaluation harness (backend/eval): 28 hand-labelled questions about pallets/click.
// Keep in step with the Quality section of the README.
const RETRIEVAL = [
  { label: 'is found by search (24 candidates)', value: 88 },
  { label: 'survives reranking (top 8)', value: 75 },
  { label: 'reaches the model, after the graph walk', value: 83, key: true },
  { label: 'reaches it completely, for every question', value: 72 },
]
const ANSWERS = [
  { label: 'of citations backed by the code shown', value: 100 },
  { label: 'cite the right code', value: 92 },
  { label: 'of expected facts stated', value: 85 },
]
const EVAL_URL = 'https://github.com/CodeBox-commits/CodeBase-RAG/tree/main/backend/eval'

/** The measured numbers. The bars draw and the figures count up once, as the band scrolls into view. */
export default function QualityBand() {
  const root = useRef<HTMLElement>(null)
  const story = useStoryMode()

  // As the band slides up over the answer, its parts rise at different speeds (data-speed).
  useScrollScene(root, (el) => {
    const scrollTrigger = { trigger: el, start: 'top bottom', end: `top top+=${NAV}`, scrub: true }
    el.querySelectorAll<HTMLElement>('[data-speed]').forEach((part) => {
      gsap.fromTo(part, { y: Number(part.dataset.speed) * 110 }, { y: 0, ease: 'none', scrollTrigger })
    })
  }, story)

  useEffect(() => {
    const el = root.current
    if (!el) return
    const mm = gsap.matchMedia()
    mm.add(MOTION_QUERY, () => {
      const trigger = { trigger: el, start: 'top 75%', once: true }
      gsap.from(el.querySelectorAll('[data-bar]'), { scaleX: 0, duration: 1.1, stagger: 0.12, ease: 'power3.out', scrollTrigger: trigger })
      el.querySelectorAll<HTMLElement>('[data-count]').forEach((n, i) => {
        const to = Number(n.dataset.count)
        const v = { n: 0 }
        gsap.to(v, {
          n: to,
          duration: 1.1,
          delay: i * 0.08,
          ease: 'power3.out',
          scrollTrigger: trigger,
          onStart: () => { n.textContent = '0' },
          onUpdate: () => { n.textContent = String(Math.round(v.n)) },
        })
      })
    })
    return () => mm.revert()
  }, [])

  return (
    <section
      ref={root}
      data-over={story ? 'answer' : undefined}
      className={cn('relative border-t bg-sheet', story && 'z-30 rounded-t-[28px] shadow-[0_-30px_60px_-20px_rgb(0_0_0/0.7)]')}
      style={story ? { marginTop: 'calc(-100svh + 3.5rem)' } : undefined}
    >
      <div className="mx-auto grid max-w-[1600px] gap-12 px-4 py-20 sm:px-6 lg:grid-cols-12 xl:px-10">
        <div data-speed="0.6" className="lg:col-span-4">
          <h2 className="display text-[clamp(1.6rem,2.6vw,2.2rem)]">Measured, not claimed</h2>
          <p className="mt-4 max-w-[42ch] text-muted-foreground">
            28 hand-labelled questions about <span className="font-mono text-[0.92em] text-foreground">pallets/click</span>, each
            naming the code a correct answer depends on. Retrieval runs make no model calls, so anyone can reproduce them.
          </p>
          <a href={EVAL_URL} target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-1 text-sm text-thread underline-offset-4 hover:underline">
            How it's measured <ArrowUpRight className="size-3.5" />
          </a>
          <p data-speed="1.8" className="mt-10 hidden lg:block">
            <span className="display block text-[clamp(5rem,9vw,8.5rem)] leading-[0.85] text-thread tabular-nums">
              <span data-count={83}>83</span>%
            </span>
            <span className="mt-2 block max-w-[30ch] text-sm text-muted-foreground">of the code a right answer needs reaches the model</span>
          </p>
        </div>

        <div className="lg:col-span-7 lg:col-start-6">
          <p className="text-sm font-medium">How much of the right code…</p>
          <ul className="mt-4 space-y-4">
            {RETRIEVAL.map((r, i) => (
              <li key={r.label} data-speed={1 + i * 0.35} className="grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-x-4 gap-y-1.5">
                <span className={cn('text-sm', r.key ? 'text-foreground' : 'text-muted-foreground')}>{r.label}</span>
                <span className={cn('row-span-2 text-right font-display text-[1.6rem] font-extrabold tabular-nums [font-stretch:118%]', r.key ? 'text-thread' : 'text-foreground')}>
                  <span data-count={r.value}>{r.value}</span>%
                </span>
                <span className="h-1.5 overflow-hidden rounded-full bg-rule/60">
                  <span data-bar className={cn('block h-full origin-left rounded-full', r.key ? 'bg-thread' : 'bg-pencil/55')} style={{ width: `${r.value}%` }} />
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-10 grid grid-cols-3 gap-6 border-t pt-6">
            {ANSWERS.map((a, i) => (
              <div key={a.label} data-speed={2.4 + i * 0.4}>
                <p className="display text-[2.2rem] tabular-nums"><span data-count={a.value}>{a.value}</span>%</p>
                <p className="mt-1 text-xs leading-snug text-muted-foreground">{a.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
