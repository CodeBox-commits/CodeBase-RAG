// Citations in answers: `path/to/file.py:12` or `file.ts:10-14`, checked by the backend
// (services/citations.py) against what the model was actually shown.

export type CitationStatus = 'verified' | 'graph' | 'wrong_line' | 'unknown_file'

export interface Citation {
  text: string
  filepath: string
  line: number
  end_line: number
  status: CitationStatus
}

// Keep in sync with the indexed languages (backend/app/core/languages). Longest first.
const EXTENSIONS = ['tsx', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'js', 'ts']
const BODY = `[\\w@.\\-/]+\\.(?:${EXTENSIONS.join('|')}):\\d+(?:\\s*[-\\u2013]\\s*\\d+)?`

/** Matches a whole string that is exactly one citation (e.g. an inline code span). */
export const CITATION_ONLY = new RegExp(`^${BODY}$`)
const CITATION_ANYWHERE = new RegExp(`(?<![\\w\`/])${BODY}`, 'g')

export const STATUS_LABEL: Record<CitationStatus, string> = {
  verified: 'Verified: this line was in the code the model was shown',
  graph: 'From the call graph: the location is real, but its code wasn’t shown to the model',
  wrong_line: 'Unverified: the file was in the context, but this line wasn’t',
  unknown_file: 'Unverified: this file was never in the context',
}

/**
 * Wraps bare citations in backticks so they render as clickable chips, leaving fenced code
 * blocks and existing inline code untouched.
 */
export function linkifyCitations(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(CITATION_ANYWHERE, (m) => `\`${m}\``)))
    .join('')
}

export function findCitation(text: string, citations: Citation[] | undefined): Citation | undefined {
  return citations?.find((c) => c.text === text.trim())
}

export function citationSummary(citations: Citation[] | undefined) {
  const list = citations ?? []
  const supported = list.filter((c) => c.status === 'verified' || c.status === 'graph').length
  return { total: list.length, supported, unsupported: list.length - supported }
}

/** Citations written so far in a (possibly still streaming) answer, in order, without repeats. */
export function citationsIn(markdown: string): { text: string; filepath: string; line: number }[] {
  const seen = new Set<string>()
  const out: { text: string; filepath: string; line: number }[] = []
  // Unlike linkifying, citations already in backticks count here (models usually write them so).
  for (const m of markdown.matchAll(new RegExp(`(?<![\\w/])${BODY}`, 'g'))) {
    const text = m[0]
    if (seen.has(text)) continue
    seen.add(text)
    const [, filepath, line] = /^(.*):(\d+)/.exec(text) ?? []
    if (filepath) out.push({ text, filepath, line: Number(line) })
  }
  return out
}
