import { AnimatePresence, motion, MotionConfig } from 'motion/react'
import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import CommandMenu from './components/CommandMenu'
import { useSpotlight } from './lib/spotlight'
import Nav from './components/Nav'
import { useRoute } from './router'
import { RepoProvider } from './state'

// Each page's code is split out, so the first page doesn't wait for the rest; the others are fetched
// once the app is idle. A page whose code has arrived renders straight away: going through lazy() again
// would hold React's placeholder up for its minimum ~300ms, and the page would fade in empty.
function page(load: () => Promise<{ default: ComponentType }>) {
  let ready: ComponentType | null = null
  const preload = () => load().then((m) => { ready = m.default; return m })
  const Lazy = lazy(preload)
  function Page() {
    const Ready = ready
    return Ready ? <Ready /> : <Lazy />
  }
  return { preload, Page }
}

const PAGES = {
  '/': page(() => import('./pages/Home')),
  '/index': page(() => import('./pages/IndexPage')),
  '/explore': page(() => import('./pages/ExplorePage')),
  '/ask': page(() => import('./pages/AskPage')),
}
/** The app's one easing, shared with the home headline. */
const EASE = [0.2, 0.7, 0.2, 1] as const

export default function App() {
  const route = useRoute()
  const [command, setCommand] = useState(false)
  useSpotlight()
  useEffect(() => {
    const prefetch = () => Object.values(PAGES).forEach((p) => void p.preload())
    const idle = window.requestIdleCallback?.(prefetch, { timeout: 3000 }) ?? window.setTimeout(prefetch, 1500)
    return () => { window.cancelIdleCallback?.(idle); window.clearTimeout(idle) }
  }, [])
  return (
    // reducedMotion="user": with "reduce motion" switched on, every Motion animation keeps only its fades.
    <MotionConfig reducedMotion="user">
    <TooltipProvider delayDuration={250}>
      <RepoProvider>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-sheet focus:px-3 focus:py-2">
          Skip to content
        </a>
        <Nav route={route} onOpenCommand={() => setCommand(true)} />
        <CommandMenu open={command} onOpenChange={setCommand} />
        <main id="main">
          {/* The old page blurs and sinks back; the new one comes into focus from just in front. Once it has
              settled, 'page:settled' tells scroll animations to measure the page again (the home story). */}
          <AnimatePresence mode="wait" initial={false} onExitComplete={() => window.scrollTo({ top: 0 })}>
            <motion.div
              key={route}
              style={{ transformOrigin: '50% 50vh' }}
              initial={{ opacity: 0, scale: 1.03, filter: 'blur(10px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)', transition: { duration: 0.45, ease: EASE }, transitionEnd: { filter: 'none' } }}
              exit={{ opacity: 0, scale: 0.97, filter: 'blur(8px)', transition: { duration: 0.22, ease: 'easeIn' } }}
              onAnimationComplete={() => window.dispatchEvent(new Event('page:settled'))}
            >
              <Suspense fallback={<div className="min-h-[calc(100svh-3.5rem)]" aria-busy />}>
                <Page route={route} />
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </main>
        <Toaster position="bottom-right" />
      </RepoProvider>
    </TooltipProvider>
    </MotionConfig>
  )
}

function Page({ route }: { route: keyof typeof PAGES }) {
  const { Page: Component } = PAGES[route]
  return <Component />
}
