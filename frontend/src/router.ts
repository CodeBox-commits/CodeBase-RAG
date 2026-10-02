import { useEffect, useState } from 'react'

export type Route = '/' | '/index' | '/explore' | '/ask'
const ROUTES: Route[] = ['/', '/index', '/explore', '/ask']

// Hash routing: FastAPI serves a single static index.html, so paths never hit the server.
function current(): Route {
  const path = window.location.hash.replace(/^#/, '') || '/'
  return (ROUTES as string[]).includes(path) ? (path as Route) : '/'
}

export function navigate(to: Route) {
  if (current() === to) return
  window.location.hash = to
  window.scrollTo({ top: 0 })
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(current)
  useEffect(() => {
    const onChange = () => setRoute(current())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
