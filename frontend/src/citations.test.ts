import { describe, expect, it } from 'vitest'
import { CITATION_ONLY, citationSummary, findCitation, linkifyCitations, type Citation } from './citations'

describe('linkifyCitations', () => {
  it('wraps bare citations in backticks so they render as chips', () => {
    expect(linkifyCitations('Signs with the newest key (src/signer.py:237).')).toBe('Signs with the newest key (`src/signer.py:237`).')
    expect(linkifyCitations('See App.tsx:10-12 and lib/x.mjs:3')).toBe('See `App.tsx:10-12` and `lib/x.mjs:3`')
  })

  it('leaves inline code and fenced blocks alone', () => {
    const md = 'Already `src/a.py:3` here.\n\n```python\n# see src/b.py:9\n```\nand src/c.py:1'
    expect(linkifyCitations(md)).toBe('Already `src/a.py:3` here.\n\n```python\n# see src/b.py:9\n```\nand `src/c.py:1`')
  })

  it('ignores things that only look like citations', () => {
    expect(linkifyCitations('http://localhost:8000 and a.pyc:3 and 12:30')).toBe('http://localhost:8000 and a.pyc:3 and 12:30')
  })
})

describe('citation lookup', () => {
  const citations: Citation[] = [
    { text: 'src/signer.py:237', filepath: 'src/signer.py', line: 237, end_line: 237, status: 'verified' },
    { text: 'timed.py:207', filepath: 'src/timed.py', line: 207, end_line: 207, status: 'graph' },
    { text: 'other.py:5', filepath: 'other.py', line: 5, end_line: 5, status: 'unknown_file' },
  ]

  it('matches a whole inline code span only', () => {
    expect(CITATION_ONLY.test('src/signer.py:237')).toBe(true)
    expect(CITATION_ONLY.test('serializer.py:10–12')).toBe(true)
    expect(CITATION_ONLY.test('call src/signer.py:237')).toBe(false)
  })

  it('finds the checked citation for a chip and summarises statuses', () => {
    expect(findCitation(' timed.py:207 ', citations)?.status).toBe('graph')
    expect(findCitation('nope.py:1', citations)).toBeUndefined()
    expect(citationSummary(citations)).toEqual({ total: 3, supported: 2, unsupported: 1 })
    expect(citationSummary(undefined)).toEqual({ total: 0, supported: 0, unsupported: 0 })
  })
})
