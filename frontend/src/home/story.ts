// The home page's scroll stories are drawn from one number: how far through the story the reader has
// scrolled (0..1). These functions turn that number into what is on screen, so scrubbing backwards
// and forwards always shows the same frame for the same scroll position.

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** Progress through a window [from, to] of a larger progress, as 0..1. */
export function segment(t: number, from: number, to: number): number {
  return clamp01((t - from) / (to - from))
}

/** How many of `total` items are showing at progress t. */
export function revealed(t: number, total: number): number {
  return Math.floor(clamp01(t) * total + 1e-9)
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

export type Token<C> =
  | { kind: 'word'; text: string; i: number }
  | { kind: 'code'; text: string; i: number }
  | { kind: 'space'; text: string }
  | { kind: 'cite'; cite: C; n: number }

/**
 * Splits an answer into what the story writes one at a time: words and code spans are numbered in
 * order across paragraphs, and each citation records the word it follows.
 */
export function tokenizeAnswer<C>(parts: ({ text: string } | { code: string } | { cite: C })[][]) {
  let words = 0
  const chipAfter: number[] = []
  const paragraphs = parts.map((paragraph) =>
    paragraph.flatMap((part): Token<C>[] => {
      if ('cite' in part) {
        chipAfter.push(words - 1)
        return [{ kind: 'cite', cite: part.cite, n: chipAfter.length - 1 }]
      }
      if ('code' in part) return [{ kind: 'code', text: part.code, i: words++ }]
      return part.text.split(/(\s+)/).filter(Boolean).map((s): Token<C> => (/^\s+$/.test(s) ? { kind: 'space', text: s } : { kind: 'word', text: s, i: words++ }))
    }),
  )
  return { paragraphs, words, chipAfter }
}

/** The answer is written over this much of its story; the rest is for the last citations to check. */
const WRITE = 0.6
/** A citation is checked this long after it has been written. */
const CHECK_LAG = 0.1

/**
 * The answer story at progress p: how many of its words are written, and which citations are checked.
 * `chipAfter[i]` is the index of the word citation i follows.
 */
export function answerProgress(p: number, words: number, chipAfter: number[]): { words: number; checked: boolean[] } {
  return {
    words: revealed(segment(p, 0, WRITE), words),
    checked: chipAfter.map((at) => p >= Math.min(0.95, (WRITE * (at + 1)) / words + CHECK_LAG)),
  }
}

/** Which panel of an n-panel gallery sits in the middle at progress p (fractional while sliding). */
export function galleryAt(progress: number, n: number): number {
  return clamp01(progress) * (n - 1)
}

/** Scrolling settles with a panel in the middle. */
export function gallerySnap(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i / (n - 1))
}

/** Panel i's scene plays over the last 80% of its slide into the middle, and stays finished after. */
export function sceneT(at: number, i: number): number {
  return clamp01(1 - (i - at) / 0.8)
}

/** How a panel looks `d` panels from the middle: smaller, dimmer and turned away, up to two panels out. */
export function panelLook(d: number): { scale: number; opacity: number; rotate: number } {
  const far = Math.min(Math.abs(d), 2)
  return { scale: 1 - 0.12 * far, opacity: 1 - 0.38 * far, rotate: -Math.sign(d) * Math.min(Math.abs(d), 1) * 14 || 0 }
}

/** 0 until a, rising to 1 at b, falling back to 0 by c. */
export function bump(p: number, a: number, b: number, c: number): number {
  return p <= b ? segment(p, a, b) : 1 - segment(p, b, c)
}
