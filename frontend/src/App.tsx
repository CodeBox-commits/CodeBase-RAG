import Nav from './components/Nav'
import AskPage from './pages/AskPage'
import ExplorePage from './pages/ExplorePage'
import Home from './pages/Home'
import IndexPage from './pages/IndexPage'
import { useRoute } from './router'
import { RepoProvider } from './state'

export default function App() {
  const route = useRoute()
  return (
    <RepoProvider>
      <Nav route={route} />
      {/* key: remount on navigation so each page's entrance animation replays */}
      <div key={route} className="route-view">
        {route === '/' && <Home />}
        {route === '/index' && <IndexPage />}
        {route === '/explore' && <ExplorePage />}
        {route === '/ask' && <AskPage />}
      </div>
    </RepoProvider>
  )
}
