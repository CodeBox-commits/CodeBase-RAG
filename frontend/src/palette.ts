import { useMemo } from 'react'

// The three.js scenes read their colours from the same CSS variables as the UI (styles.css),
// so the city and the interface can't drift apart.

export interface ModelPalette {
  dark: boolean
  ground: number
  plot: number
  shadow: number
  graphite: number
  pencil: number
  rule: number
  thread: number
  highlight: number
  kinds: Record<string, number>
  edges: Record<string, number>
}

function cssColor(styles: CSSStyleDeclaration, name: string, fallback: string): number {
  const raw = styles.getPropertyValue(name).trim() || fallback
  // Only #rrggbb is used for these variables.
  return Number.parseInt(raw.replace('#', '').slice(0, 6), 16)
}

export function readPalette(): ModelPalette {
  const s = getComputedStyle(document.documentElement)
  const c = (name: string, fallback: string) => cssColor(s, name, fallback)
  const thread = c('--thread', '#b18cff')
  return {
    dark: true,
    ground: c('--film', '#140f2e'),
    plot: c('--sheet', '#1b1540'),
    shadow: 0x05030f,
    graphite: c('--graphite', '#eeeaf8'),
    pencil: c('--pencil', '#a49cc8'),
    rule: c('--rule', '#3a2f6e'),
    thread,
    highlight: c('--highlight', '#ffc96b'),
    kinds: {
      function: c('--kind-function', '#a3ee7f'),
      method: c('--kind-method', '#5fd6f2'),
      class: c('--kind-class', '#ff7aa8'),
    },
    edges: {
      CALLS: thread,
      INHERITS: c('--kind-class', '#ff7aa8'),
      HAS_METHOD: 0x4a3c8c,
      OVERRIDES: c('--highlight', '#ffc96b'),
    },
  }
}

/** The palette, read once from the CSS variables. */
export function useModelPalette(): ModelPalette {
  return useMemo(() => readPalette(), [])
}

export const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`

/** CSS for each symbol kind and edge type, for legends and lists (same meaning as in the model). */
export const KIND_VAR: Record<string, string> = {
  function: 'var(--kind-function)',
  method: 'var(--kind-method)',
  class: 'var(--kind-class)',
}
export const EDGE_LABEL: Record<string, string> = {
  CALLS: 'calls',
  INHERITS: 'inherits',
  HAS_METHOD: 'has method',
  OVERRIDES: 'overrides',
}

