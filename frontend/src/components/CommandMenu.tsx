import { Box, Compass, FolderGit2, MessageSquareText, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { getRepoGraph, type GraphNode } from '../api'
import { navigate } from '../router'
import { repoName, useRepos } from '../state'
import { StatusDot } from './Nav'

/** ⌘K: go to a page, switch repository, jump to a symbol of the active repository. */
export default function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { repos, active, setActive, setFocusSymbol } = useRepos()
  const [symbols, setSymbols] = useState<{ url: string; nodes: GraphNode[] } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  // Symbols load the first time the menu opens for a repository.
  const ready = active?.state === 'ready'
  useEffect(() => {
    if (!open || !ready || !active || symbols?.url === active.url) return
    let cancelled = false
    getRepoGraph(active.url, 1500)
      .then((g) => { if (!cancelled) setSymbols({ url: active.url, nodes: g.nodes }) })
      .catch(() => { /* the symbol group just stays empty */ })
    return () => { cancelled = true }
  }, [open, ready, active, symbols?.url])

  const run = (fn: () => void) => { onOpenChange(false); fn() }
  const nodes = symbols && active && symbols.url === active.url ? symbols.nodes : []

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search" description="Go to a page, switch repository or find a symbol">
      <CommandInput placeholder={active ? `Search pages, repositories or symbols in ${repoName(active.url)}` : 'Search pages and repositories'} />
      <CommandList className="max-h-[min(70vh,28rem)]">
        <CommandEmpty>Nothing matches. Symbols come from the repository selected at the top.</CommandEmpty>
        <CommandGroup heading="Pages">
          <CommandItem onSelect={() => run(() => navigate('/index'))}><FolderGit2 /> Index a repository</CommandItem>
          <CommandItem onSelect={() => run(() => navigate('/explore'))}><Compass /> Explore the city</CommandItem>
          <CommandItem onSelect={() => run(() => navigate('/ask'))}><MessageSquareText /> Ask a question</CommandItem>
        </CommandGroup>
        {repos.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch repository">
              {repos.map((r) => (
                <CommandItem key={r.url} value={`repo ${r.url}`} onSelect={() => run(() => setActive(r.url))} className="gap-2.5">
                  <StatusDot state={r.state} className="ml-0.5" />
                  <span className="font-mono text-[0.8rem]">{repoName(r.url)}</span>
                </CommandItem>
              ))}
              <CommandItem value="index another repository" onSelect={() => run(() => navigate('/index'))}><Plus /> Index another repository</CommandItem>
            </CommandGroup>
          </>
        )}
        {nodes.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={`Symbols in ${repoName(active!.url)}`}>
              {nodes.slice(0, 1500).map((n) => (
                <CommandItem
                  key={n.id}
                  value={`${n.name ?? n.id} ${n.filepath ?? ''}`}
                  onSelect={() => run(() => { setFocusSymbol(n.id); navigate('/explore') })}
                  className="gap-2.5"
                >
                  <Box className="opacity-60" />
                  <span className="min-w-0 truncate font-mono text-[0.8rem]">{n.name ?? n.id}</span>
                  <span className="ml-auto min-w-0 truncate font-mono text-[0.72rem] text-muted-foreground">{n.filepath}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
