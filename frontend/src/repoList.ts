import type { IndexedRepo } from './api'
import type { Repo } from './state'

/**
 * Adds repositories indexed elsewhere (another browser, port 5173, the API or an MCP client)
 * to the local list and refreshes symbol counts. Local entries keep their task state.
 */
export function mergeServerRepos(local: Repo[], server: IndexedRepo[]): Repo[] {
  const counts = new Map(server.map((s) => [s.url, s.symbols]))
  const known = new Set(local.map((r) => r.url))
  const updated = local.map((r) => (counts.has(r.url) ? { ...r, symbols: counts.get(r.url) } : r))
  const added: Repo[] = server
    .filter((s) => !known.has(s.url))
    .map((s) => ({ url: s.url, state: 'ready', symbols: s.symbols, indexedAt: s.last_indexed ?? undefined }))
  return [...updated, ...added]
}
