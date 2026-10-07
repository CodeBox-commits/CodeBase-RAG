import { lazy, Suspense, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import CommandMenu from './components/CommandMenu'
import Nav from './components/Nav'
import { useRoute } from './router'
import { RepoProvider } from './state'

// Each page loads on first visit, so the home page doesn't pay for the rest.
const Home = lazy(() => import('./pages/Home'))
const IndexPage = lazy(() => import('./pages/IndexPage'))
const ExplorePage = lazy(() => import('./pages/ExplorePage'))
const AskPage = lazy(() => import('./pages/AskPage'))

export default function App() {
  const route = useRoute()
  const [command, setCommand] = useState(false)
  return (
    <TooltipProvider delayDuration={250}>
      <RepoProvider>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-sheet focus:px-3 focus:py-2">
          Skip to content
        </a>
        <Nav route={route} onOpenCommand={() => setCommand(true)} />
        <CommandMenu open={command} onOpenChange={setCommand} />
        <main id="main">
          <Suspense fallback={<div className="min-h-[calc(100svh-3.5rem)]" aria-busy />}>
            {route === '/' && <Home />}
            {route === '/index' && <IndexPage />}
            {route === '/explore' && <ExplorePage />}
            {route === '/ask' && <AskPage />}
          </Suspense>
        </main>
        <Toaster position="bottom-right" />
      </RepoProvider>
    </TooltipProvider>
  )
}
