import { useMemo } from 'react'
import { useTheme } from './theme'

// The three.js scenes read their colours from the same CSS variables as the UI (styles.css),
// so the model follows the theme: card and basswood on drafting film, or a cyanotype.

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
  const dark = document.documentElement.classList.contains('dark')
  const thread = c('--thread', '#1233c4')
  return {
    dark,
    ground: c('--model-ground', '#dfe3dd'),
    plot: c('--model-plot', '#eceee9'),
    shadow: c('--model-shadow', '#9aa39a'),
    graphite: c('--graphite', '#1d2128'),
    pencil: c('--pencil', '#575f6b'),
    rule: c('--rule', '#c6ccc4'),
    thread,
    highlight: c('--highlight', '#ffe15c'),
    kinds: {
      function: c('--kind-function', '#fbfbf8'),
      method: c('--kind-method', '#cfd5cf'),
      class: c('--kind-class', '#c8b28c'),
    },
    edges: {
      CALLS: thread,
      INHERITS: c('--pencil', '#575f6b'),
      HAS_METHOD: c('--rule', '#c6ccc4'),
      OVERRIDES: dark ? 0xffc78a : 0x9a6a14,
    },
  }
}

/** The palette for the current theme; a new object (so scenes rebuild) only when the theme changes. */
export function useModelPalette(): ModelPalette {
  const { theme } = useTheme()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readPalette(), [theme])
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

