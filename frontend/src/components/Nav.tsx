import { useEffect, useState } from 'react'
import { navigate, type Route } from '../router'
import { repoName, useRepos } from '../state'

const LINKS: { to: Route; label: string }[] = [
  { to: '/', label: 'Home' },
  { to: '/index', label: 'Index' },
  { to: '/explore', label: 'Explore' },
  { to: '/ask', label: 'Ask' },
]

export function Logo() {
  // Three towers on a plot: the code city mark.
  return (
    <span className="nav-logo" aria-hidden>
      <svg viewBox="0 0 26 26" width="26" height="26">
        <rect x="2" y="12" width="6" height="12" fill="var(--cyan)" />
        <rect x="10" y="3" width="6" height="21" fill="var(--lit)" />
        <rect x="18" y="9" width="6" height="15" fill="var(--rose)" />
      </svg>
    </span>
  )
}

export default function Nav({ route }: { route: Route }) {
  const { repos, active, setActive } = useRepos()
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const go = (to: Route) => {
    setOpen(false)
    navigate(to)
  }

  return (
    <nav className={`nav ${scrolled || route !== '/' ? 'scrolled' : ''}`}>
      <a href="#/" className="nav-brand" aria-label="Codebase RAG home" onClick={(e) => { e.preventDefault(); go('/') }}>
        <Logo />
        <span className="nav-brand-text">Codebase RAG</span>
      </a>

      <div className={`nav-links ${open ? 'open' : ''}`}>
        {LINKS.map((l) => (
          <a
            key={l.to}
            href={`#${l.to}`}
            className={route === l.to ? 'active' : ''}
            aria-current={route === l.to ? 'page' : undefined}
            onClick={(e) => { e.preventDefault(); go(l.to) }}
          >
            {l.label}
          </a>
        ))}
      </div>

      <div className="nav-right">
        {repos.length > 0 && (
          <label className="repo-select">
            <span className={`dot ${active?.state ?? ''}`} aria-hidden />
            <select
              value={active?.url ?? ''}
              onChange={(e) => setActive(e.target.value)}
              aria-label="Active repository"
            >
              {!active && <option value="">Choose repository</option>}
              {repos.map((r) => (
                <option key={r.url} value={r.url}>{repoName(r.url)}</option>
              ))}
            </select>
          </label>
        )}
        {route === '/' && (
          <a href="#/index" className="btn btn-primary btn-sm nav-cta" onClick={(e) => { e.preventDefault(); go('/index') }}>
            Index a repository
          </a>
        )}
        <button className="nav-burger" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span /><span /><span />
        </button>
      </div>
    </nav>
  )
}
