import { describe, expect, it } from 'vitest'
import { mergeServerRepos } from './repoList'
import type { Repo } from './state'

describe('mergeServerRepos', () => {
  const local: Repo[] = [
    { url: 'https://github.com/a/indexing', state: 'indexing', taskId: 't1' },
    { url: 'https://github.com/a/known', state: 'ready' },
  ]

  it('adds repositories indexed elsewhere and refreshes counts, keeping local task state', () => {
    const merged = mergeServerRepos(local, [
      { url: 'https://github.com/a/known', last_indexed: 1, symbols: 72 },
      { url: 'https://github.com/b/other', last_indexed: 2, symbols: 5 },
    ])
    expect(merged).toEqual([
      { url: 'https://github.com/a/indexing', state: 'indexing', taskId: 't1' },
      { url: 'https://github.com/a/known', state: 'ready', symbols: 72 },
      { url: 'https://github.com/b/other', state: 'ready', symbols: 5, indexedAt: 2 },
    ])
  })

  it('is a no-op when the server has nothing new', () => {
    expect(mergeServerRepos(local, [])).toEqual(local)
  })
})
