import { useEffect } from 'react'

/**
 * Lights `.spotlight` elements where the mouse is: one listener for the whole page sets --mx/--my on
 * the element under the cursor and --spot to 1 (styles.css draws the glow). Mouse only, and only when
 * the reader allows motion.
 */
export function useSpotlight() {
  useEffect(() => {
    if (!window.matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches) return
    let lit: HTMLElement | null = null
    const off = () => { lit?.style.setProperty('--spot', '0'); lit = null }
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      const el = (e.target as Element | null)?.closest<HTMLElement>('.spotlight') ?? null
      if (el !== lit) { off(); lit = el }
      if (!el) return
      const r = el.getBoundingClientRect()
      el.style.setProperty('--mx', `${e.clientX - r.left}px`)
      el.style.setProperty('--my', `${e.clientY - r.top}px`)
      el.style.setProperty('--spot', '1')
    }
    window.addEventListener('pointermove', move, { passive: true })
    document.documentElement.addEventListener('pointerleave', off)
    return () => {
      window.removeEventListener('pointermove', move)
      document.documentElement.removeEventListener('pointerleave', off)
      off()
    }
  }, [])
}
