import { Check } from 'lucide-react'
import { memo, useRef, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { QUESTION } from './sampleStory'
import { PIPELINE, type PipelineStep } from './steps'
import { galleryAt, gallerySnap, panelLook, sceneT } from './story'
import { useScrollProgress, useStoryMode } from './useScrollStory'

/** Screens of scrolling it takes to slide through every step. */
const LENGTH = 2.6
const SNAP = gallerySnap(PIPELINE.length)
/** A panel's width; the track moves one panel plus the gap per step. */
const PANEL = 'min(44rem, 52vw)'
const GAP = '2.5rem'

/** A panel's scene, redrawn only when its frame changes: panels already played or not yet reached hold still. */
const SceneSlot = memo(function SceneSlot({ Scene, t }: { Scene: PipelineStep['Scene']; t: number }) {
  return <Scene t={t} />
})

function Intro({ className }: { className?: string }) {
  return (
    <div className={className}>
      <h2 className="display text-[clamp(1.8rem,3vw,2.6rem)]">How a question gets answered</h2>
      <p className="mt-3 max-w-[44ch] text-muted-foreground">
        Follow one question through the steps every question takes. On the Ask page each step opens up to show what it found.
      </p>
    </div>
  )
}

/**
 * "How a question gets answered". On wide screens it's a card that slides up over the hero, holds,
 * and turns scrolling into a sideways gallery: each step is a panel that plays its scene as it reaches
 * the middle, with the neighbours smaller and turned away. Elsewhere it's the list of steps.
 */
export default function PipelineStory() {
  const story = useStoryMode()
  const outer = useRef<HTMLElement>(null)
  const progress = useScrollProgress(outer, { enabled: story, length: LENGTH, snap: SNAP })
  const at = galleryAt(progress, PIPELINE.length)
  const current = Math.round(at)

  if (!story) {
    return (
      <section className="border-y bg-sheet">
        <div className="mx-auto max-w-[1600px] px-4 py-16 sm:px-6">
          <Intro />
          <ol className="mt-10 grid gap-x-8 gap-y-7 sm:grid-cols-2">
            {PIPELINE.map((s, i) => (
              <li key={s.title} className="border-t border-rule pt-4">
                <span className="display block text-[2.6rem] leading-none tabular-nums">{i + 1}</span>
                <h3 className="mt-2 font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
    )
  }

  const slot = (d: number) => `calc(${d} * (${PANEL} + ${GAP}))`
  return (
    // Slides up over the hero (the negative margin), holds for the gallery, then holds again while the
    // answer slides up over it: twice the card's height plus the gallery's scrolling.
    <section
      ref={outer}
      data-over="hero"
      className="relative z-10"
      style={{ marginTop: 'calc(-100svh + 3.5rem)', height: `calc(2 * (100svh - 3.5rem) + ${LENGTH * 100}svh)` }}
    >
      <div
        data-layer="pipeline"
        className="sticky top-14 flex h-[calc(100svh-3.5rem)] flex-col overflow-hidden rounded-t-[28px] border-t bg-sheet shadow-[0_-30px_60px_-20px_rgb(0_0_0/0.7)]"
      >
        <div className="mx-auto flex w-full max-w-[1600px] items-end justify-between gap-10 px-10 pt-10">
          <Intro />
          <ol className="flex gap-1.5" aria-label="Steps">
            {PIPELINE.map((s, i) => (
              <li
                key={s.title}
                aria-current={i === current ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs whitespace-nowrap transition-colors duration-300',
                  i < current && 'border-rule bg-sheet-2 text-graphite',
                  i === current && 'border-thread/60 text-thread',
                  i > current && 'text-muted-foreground/70',
                )}
              >
                {i < current ? <Check className="size-3" /> : <span className="tabular-nums">{i + 1}</span>}
                {s.title}
              </li>
            ))}
          </ol>
        </div>

        <div className="relative min-h-0 flex-1 [perspective:1400px]">
          {/* Step numbers behind the panels, moving at about half their speed for depth. */}
          {PIPELINE.map((s, i) => (
            <span
              key={s.title}
              aria-hidden
              className="display pointer-events-none absolute top-1/2 left-1/2 text-[38svh] leading-none text-foreground/[0.035] tabular-nums"
              style={{ transform: `translate(-50%, -50%) translateX(calc(0.55 * ${slot(i - at)}))` }}
            >
              {i + 1}
            </span>
          ))}

          {PIPELINE.map((s, i) => {
            const d = i - at
            if (Math.abs(d) > 2.6) return null
            const look = panelLook(d)
            const style: CSSProperties = {
              width: PANEL,
              left: `calc(50% - ${PANEL} / 2)`,
              transform: `translateX(${slot(d)}) rotateY(${look.rotate}deg) scale(${look.scale})`,
              opacity: look.opacity,
              zIndex: 10 - Math.round(Math.abs(d) * 2),
            }
            const live = Math.abs(d) < 0.5
            return (
              <article
                key={s.title}
                aria-hidden={!live}
                className="absolute inset-y-0 my-auto flex h-[min(36rem,calc(100%-3rem))] flex-col overflow-hidden rounded-2xl border bg-background/80 p-7 shadow-[0_30px_60px_-30px_rgb(0_0_0/0.8)]"
                style={style}
              >
                <header className="flex items-baseline gap-4">
                  <span className={cn('display text-[2.4rem] leading-none tabular-nums', live ? 'text-foreground' : 'text-muted-foreground')}>{i + 1}</span>
                  <div className="min-w-0">
                    <h3 className="font-semibold">{s.title}</h3>
                    <p className="mt-0.5 text-[0.84rem] leading-relaxed text-muted-foreground">{s.body}</p>
                  </div>
                </header>
                <p className={cn('mt-5 mb-4 flex items-center gap-2 border-t pt-4 text-sm font-medium transition-colors duration-300', live ? 'text-thread' : 'text-muted-foreground')}>
                  <s.icon className="size-4" /> {s.caption}…
                  {i > 0 && <span className="ml-auto truncate pl-4 text-xs font-normal text-muted-foreground">{QUESTION}</span>}
                </p>
                <div className="min-h-0 flex-1">
                  {/* Panels more than one step away are too small and dim to read: skip drawing their scenes. */}
                  {Math.abs(d) < 1.6 && <SceneSlot Scene={s.Scene} t={Math.round(sceneT(at, i) * 200) / 200} />}
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}
