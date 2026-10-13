import { useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { STATUS_LABEL } from '../citations'
import CodeBlock from '../components/CodeBlock'
import { CitationChip, StatusMark, type CitationTarget } from '../components/CodeViewer'
import { ANSWER, QUESTION, SAMPLE_CODE } from './sampleStory'
import { answerProgress, bump, tokenizeAnswer } from './story'
import { gsap, NAV, useScrollProgress, useScrollScene, useStoryMode } from './useScrollStory'

/** Screens of scrolling the answer takes to write and check. No snapping: it reads at any point. */
const LENGTH = 1.2

/**
 * "Every citation is checked": on wide screens the sample answer writes itself as you scroll, each
 * citation turns from a spinner to its mark, and the code beside it marks the line it points at.
 * Elsewhere, and once played, it's the finished answer, where clicking a citation shows its code.
 */
export default function AnswerStory() {
  const story = useStoryMode()
  const outer = useRef<HTMLElement>(null)
  const progress = useScrollProgress(outer, { enabled: story, length: LENGTH })
  // While the card slides up, its parts arrive from different depths: copy, answer, then the code.
  useScrollScene(outer, (root) => {
    const scrollTrigger = { trigger: root, start: 'top bottom', end: `top top+=${NAV}`, scrub: true }
    const from = { intro: { y: 90, opacity: 0.2 }, answer: { y: 170, opacity: 0.3 }, code: { x: 240, y: 110, opacity: 0.2 } }
    for (const [part, start] of Object.entries(from)) {
      gsap.fromTo(root.querySelector(`[data-arrive="${part}"]`), start, { x: 0, y: 0, opacity: 1, ease: 'none', scrollTrigger })
    }
  }, story)
  // Near the end the code zooms in on the lines the last citation points at, then eases back.
  const zoom = 1 + 0.09 * bump(progress, 0.6, 0.78, 1)
  const [viewing, setViewing] = useState<CitationTarget | null>(null)

  const answer = useMemo(() => tokenizeAnswer(ANSWER), [])
  const { words, checked } = answerProgress(progress, answer.words, answer.chipAfter)
  const writing = words < answer.words
  const chips = answer.paragraphs.flat().filter((tok) => tok.kind === 'cite')
  const doneCount = checked.filter(Boolean).length
  // The code panel follows the latest checked citation into the file it shows, unless the reader clicked one.
  const lastChecked = [...chips].reverse().find((c) => c.kind === 'cite' && checked[c.n] && c.cite.filepath === 'billing/service.py')
  const shown = viewing ?? (lastChecked?.kind === 'cite' ? lastChecked.cite : null)
  const mark: [number, number] | undefined = shown?.filepath === 'billing/service.py' ? [shown.line, shown.end_line] : undefined

  const body = (
    <div className="grid items-start gap-10 lg:grid-cols-12">
      <div data-arrive="intro" className="lg:col-span-5">
        <h2 className="display text-[clamp(1.8rem,3vw,2.6rem)]">Every citation is checked against what the model saw</h2>
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
        <div data-arrive="answer">
        <figure className="rounded-xl border bg-sheet p-5 sm:p-6">
          <p className="text-sm font-medium">{QUESTION}</p>
          <div className="prose-answer mt-3">
            {answer.paragraphs.map((tokens, pi) => (
              <p key={pi}>
                {tokens.map((tok, ti) => {
                  if (tok.kind === 'space') return tok.text
                  if (tok.kind === 'cite') {
                    const on = words > answer.chipAfter[tok.n]
                    return (
                      <span key={ti} className={cn('transition-opacity duration-200', !on && 'opacity-0')}>
                        <CitationChip target={{ ...tok.cite, status: checked[tok.n] ? tok.cite.status : undefined }} onOpen={setViewing} />
                      </span>
                    )
                  }
                  const on = tok.i < words
                  const content = tok.kind === 'code' ? <code>{tok.text}</code> : tok.text
                  return (
                    <span key={ti} className={cn('transition-opacity duration-150', !on && 'opacity-0')}>
                      {content}
                      {writing && tok.i === words - 1 && <span aria-hidden className="ml-0.5 inline-block h-[1.05em] w-[0.5ch] translate-y-[0.15em] animate-pulse bg-thread" />}
                    </span>
                  )
                })}
              </p>
            ))}
          </div>
          <figcaption className="mt-4 border-t pt-3 text-xs text-muted-foreground">
            <span className="tabular-nums">{doneCount} of {chips.length}</span> citations checked. A sample answer about the sample repository.
          </figcaption>
        </figure>
        </div>

        <div data-arrive="code">

        <figure
          className={cn('overflow-hidden rounded-xl border bg-sheet shadow-[0_30px_60px_-30px_rgb(0_0_0/0.8)] transition-shadow', viewing && 'ring-2 ring-thread/40')}
          style={{ transform: `scale(${zoom})`, transformOrigin: '50% 58%' }}
        >
          <figcaption className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5">
            <span className="font-mono text-[0.78rem]">billing/service.py</span>
            <span className="text-xs text-muted-foreground">{shown ? `Showing ${shown.text}` : 'Waiting for a citation'}</span>
          </figcaption>
          <CodeBlock code={SAMPLE_CODE} lang="python" startLine={42} mark={mark} className="bg-background/40" />
          {shown?.filepath === 'api/checkout.py' && (
            <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
              <span className="font-mono text-foreground">api/checkout.py:88</span> came from the call graph: the location is
              real, but its code wasn't in the model's context.
            </p>
          )}
        </figure>
        </div>
      </div>
    </div>
  )

  if (!story) {
    return (
      <section id="answer" className="mx-auto max-w-[1600px] scroll-mt-20 px-4 py-20 sm:px-6">
        {body}
      </section>
    )
  }

  return (
    // Slides up over the pipeline, holds while the answer writes itself, then holds again while the
    // numbers slide up over it.
    <section
      ref={outer}
      data-over="pipeline"
      className="relative z-20"
      style={{ marginTop: 'calc(-100svh + 3.5rem)', height: `calc(2 * (100svh - 3.5rem) + ${LENGTH * 100}svh)` }}
    >
      {/* "See a checked answer" lands here: the point where the story has finished playing. */}
      <span id="answer" aria-hidden className="absolute inset-x-0 h-px scroll-mt-14" style={{ top: `${LENGTH * 100}svh` }} />
      <div
        data-layer="answer"
        className="sticky top-14 flex h-[calc(100svh-3.5rem)] items-center overflow-hidden rounded-t-[28px] border-t bg-background shadow-[0_-30px_60px_-20px_rgb(0_0_0/0.7)]"
      >
        <div className="mx-auto w-full max-w-[1600px] px-10">{body}</div>
      </div>
    </section>
  )
}
