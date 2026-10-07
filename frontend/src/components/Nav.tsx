import { Check, ChevronsUpDown, Menu, Moon, Plus, Search, Sun, SunMoon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { navigate, type Route } from '../router'
import { repoName, useRepos, type Repo } from '../state'
import { useTheme, type ThemeChoice } from '../theme'

const LINKS: { to: Route; label: string }[] = [
  { to: '/index', label: 'Index' },
  { to: '/explore', label: 'Explore' },
  { to: '/ask', label: 'Ask' },
]

/** The mark: three blocks on a board, one thread between them. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden>
      <rect width="32" height="32" rx="7" className="fill-graphite" />
      <path d="M6 24h20" className="stroke-rule" strokeWidth="1.5" />
      <rect x="7" y="14" width="5" height="10" fill="var(--kind-function)" />
      <rect x="13.5" y="7" width="5" height="17" fill="var(--kind-class)" />
      <rect x="20" y="11" width="5" height="13" fill="var(--kind-method)" />
      <path d="M9.5 14 C 12 4, 20 4, 22.5 11" stroke="#6d86ff" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function StatusDot({ state, className }: { state?: Repo['state']; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        state === 'ready' && 'bg-verified',
        state === 'indexing' && 'animate-pulse bg-highlight ring-1 ring-graphite/30',
        state === 'failed' && 'bg-check',
        !state && 'bg-rule',
        className,
      )}
    />
  )
}

function RepoSwitcher() {
  const { repos, active, setActive } = useRepos()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-[15rem] justify-between gap-2 bg-sheet" aria-label="Choose repository">
          <StatusDot state={active?.state} />
          <span className="truncate font-mono text-[0.78rem]">{active ? repoName(active.url) : 'Choose repository'}</span>
          <ChevronsUpDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <Command>
          <CommandInput placeholder="Find a repository" />
          <CommandList>
            <CommandEmpty>No repository matches.</CommandEmpty>
            <CommandGroup heading="Indexed on this server">
              {repos.map((r) => (
                <CommandItem
                  key={r.url}
                  value={r.url}
                  onSelect={() => { setActive(r.url); setOpen(false) }}
                  className="gap-2.5"
                >
                  <StatusDot state={r.state} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.78rem]">{repoName(r.url)}</span>
                  {r.symbols != null && <span className="text-xs text-muted-foreground tabular-nums">{r.symbols}</span>}
                  {active?.url === r.url && <Check className="size-3.5" />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem onSelect={() => { setOpen(false); navigate('/index') }} className="gap-2.5">
                <Plus className="size-3.5" /> Index another repository
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function ThemeMenu() {
  const { choice, theme, setChoice } = useTheme()
  const Icon = choice === 'system' ? SunMoon : theme === 'dark' ? Moon : Sun
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Theme">
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuRadioGroup value={choice} onValueChange={(v) => setChoice(v as ThemeChoice)}>
          <DropdownMenuRadioItem value="light">Drafting film (light)</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Cyanotype (dark)</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">Match system</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default function Nav({ route, onOpenCommand }: { route: Route; onOpenCommand: () => void }) {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const mac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const go = (to: Route) => { setMenuOpen(false); navigate(to) }
  const links = LINKS.map((l) => (
    <a
      key={l.to}
      href={`#${l.to}`}
      aria-current={route === l.to ? 'page' : undefined}
      onClick={(e) => { e.preventDefault(); go(l.to) }}
      className={cn(
        'relative rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
        'aria-[current=page]:text-foreground',
        // The current page is underlined with the thread, like the selected block in the model.
        'after:absolute after:inset-x-3 after:-bottom-[13px] after:h-0.5 after:scale-x-0 after:bg-thread after:transition-transform aria-[current=page]:after:scale-x-100',
      )}
    >
      {l.label}
    </a>
  ))

  return (
    <header
      className={cn(
        'sticky top-0 z-40 h-14 border-b transition-colors',
        scrolled || route !== '/' ? 'border-rule bg-background/90 backdrop-blur-md' : 'border-transparent bg-transparent',
      )}
    >
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-2 px-4 sm:px-6">
        <a
          href="#/"
          onClick={(e) => { e.preventDefault(); go('/') }}
          className="mr-3 flex items-center gap-2.5 rounded-md"
          aria-label="Codebase RAG home"
        >
          <Mark />
          <span className="display hidden whitespace-nowrap text-[1.45rem] leading-none tracking-[-0.005em] sm:inline">Codebase RAG</span>
        </a>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">{links}</nav>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenCommand}
            className="hidden gap-2 bg-sheet pr-1.5 text-muted-foreground sm:inline-flex"
            aria-label="Search pages, repositories and symbols"
          >
            <Search className="size-3.5" />
            <span className="text-xs">Search</span>
            <Kbd>{mac ? '⌘' : 'Ctrl'} K</Kbd>
          </Button>
          <RepoSwitcher />
          <ThemeMenu />
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Menu">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-64 gap-1 p-4 pt-12">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              {LINKS.map((l) => (
                <button
                  key={l.to}
                  onClick={() => go(l.to)}
                  className={cn('rounded-md px-3 py-2 text-left text-base', route === l.to ? 'bg-accent font-medium' : 'text-muted-foreground')}
                >
                  {l.label}
                </button>
              ))}
              <button onClick={() => { setMenuOpen(false); onOpenCommand() }} className="rounded-md px-3 py-2 text-left text-base text-muted-foreground">
                Search
              </button>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}
