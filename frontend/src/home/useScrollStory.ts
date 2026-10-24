import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react'

gsap.registerPlugin(ScrollTrigger)
// The page wrapper scales while a page comes in (App.tsx), so positions measured then are off: measure
// again once it has settled.
window.addEventListener('page:settled', () => ScrollTrigger.refresh())

// Scroll stories run on wide screens for readers who haven't asked for less motion. Everyone else gets
// each story in its finished state, so nothing is lost by not scrolling through it.
const STORY_QUERY = '(min-width: 1024px) and (prefers-reduced-motion: no-preference)'
const MOTION_QUERY = '(prefers-reduced-motion: no-preference)'
/** The sticky nav's height: stories pin just below it. */
const NAV = 56

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(STORY_QUERY)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/** Whether scroll stories play here (a wide screen, and motion allowed). */
export function useStoryMode(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(STORY_QUERY).matches, () => false)
}

/**
 * How far the reader has scrolled through a story (0..1). `ref` is the story's tall outer box, whose
 * sticky child stays on screen while it scrolls past; the story starts when that child pins under the
 * nav and lasts `length` screens. When scrolling stops it settles on the nearest of `snap`. Disabled,
 * the story is finished: 1.
 */
export function useScrollProgress(
  ref: RefObject<HTMLElement | null>,
  { enabled, length, snap }: { enabled: boolean; length: number; snap?: number[] },
): number {
  const [progress, setProgress] = useState(0)
  const snapKey = snap?.join(',')

  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) return
    let frame = 0
    const trigger = ScrollTrigger.create({
      trigger: el,
      start: `top top+=${NAV}`,
      end: () => `+=${window.innerHeight * length}`,
      onUpdate: (self) => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => setProgress(self.progress))
      },
      snap: snap ? { snapTo: snap, duration: { min: 0.2, max: 0.6 }, delay: 0.08, ease: 'power1.inOut' } : undefined,
    })
    setProgress(trigger.progress)
    return () => {
      cancelAnimationFrame(frame)
      trigger.kill()
    }
  }, [ref, enabled, length, snapKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return enabled ? progress : 1
}

/**
 * Builds scroll-scrubbed GSAP animations inside `ref`, only where scroll stories play. Everything it
 * creates is undone when the component unmounts or the screen stops qualifying.
 */
export function useScrollScene(ref: RefObject<HTMLElement | null>, setup: (root: HTMLElement) => void, enabled: boolean) {
  useEffect(() => {
    const root = ref.current
    if (!enabled || !root) return
    const mm = gsap.matchMedia()
    mm.add(STORY_QUERY, () => setup(root))
    return () => mm.revert()
  }, [ref, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** Fades `[data-reveal]` elements inside `ref` up into place as they scroll into view (once each). */
export function useReveal(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const mm = gsap.matchMedia()
    mm.add(MOTION_QUERY, () => {
      const items = root.querySelectorAll<HTMLElement>('[data-reveal]')
      gsap.set(items, { opacity: 0, y: 18 })
      ScrollTrigger.batch(items, {
        start: 'top 88%',
        once: true,
        onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: 'power2.out', overwrite: true }),
      })
    })
    return () => mm.revert()
  }, [ref])
}

export { gsap, ScrollTrigger, MOTION_QUERY, NAV }
