import type { HighlighterCore, ThemedToken } from 'shiki/core'

// Syntax highlighting for the languages that are indexed, loaded on first use. The theme
// maps tokens to CSS variables (styles.css), so code follows the light and dark drawings.

const LANGS = {
  python: () => import('shiki/langs/python.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
}
export type Lang = keyof typeof LANGS | 'text'

let highlighter: Promise<HighlighterCore> | null = null

function load(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ])
    return createHighlighterCore({
      themes: [createCssVariablesTheme({ name: 'drawing', variablePrefix: '--shiki-', fontStyle: true })],
      langs: Object.values(LANGS).map((l) => l()),
      engine: createJavaScriptRegexEngine(),
    })
  })()
  return highlighter
}

export function langFor(filepath?: string | null): Lang {
  const ext = filepath?.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'py': return 'python'
    case 'ts': case 'mts': case 'cts': return 'typescript'
    case 'tsx': return 'tsx'
    case 'js': case 'mjs': case 'cjs': return 'javascript'
    case 'jsx': return 'jsx'
    case 'sh': case 'bash': return 'bash'
    default: return 'text'
  }
}

export async function tokenize(code: string, lang: Lang): Promise<ThemedToken[][] | null> {
  if (lang === 'text') return null
  try {
    const h = await load()
    return h.codeToTokens(code, { lang, theme: 'drawing' }).tokens
  } catch {
    return null
  }
}
