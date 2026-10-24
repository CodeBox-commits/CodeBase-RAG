import { ArrowDownUp, Binary, Network, PackagePlus, Search, Signpost, Sparkles, type LucideIcon } from 'lucide-react'
import type { JSX } from 'react'
import { AskMore, Embed, Graph, Plan, Rerank, Route, SearchScene } from './scenes'

export interface PipelineStep {
  title: string
  /** What the step does, shown beside the scene. */
  body: string
  /** What the stage says while the step plays. */
  caption: string
  icon: LucideIcon
  Scene: (p: { t: number }) => JSX.Element
}

export const PIPELINE: PipelineStep[] = [
  { title: 'Plan', icon: Sparkles, Scene: Plan, caption: 'Reading the question', body: 'One model call works out what kind of question it is, picks out symbol names and writes up to three search queries.' },
  { title: 'Route', icon: Signpost, Scene: Route, caption: 'Choosing a route', body: 'The kind of question decides how much to lean on keyword search and how far to walk the call graph.' },
  { title: 'Embed', icon: Binary, Scene: Embed, caption: 'Turning the searches into vectors', body: 'Each search query becomes a vector, locally on the CPU, so it can be compared with every indexed symbol.' },
  { title: 'Search', icon: Search, Scene: SearchScene, caption: 'Searching vectors and keywords', body: 'Vector search and BM25 keyword search run side by side and merge by rank, so exact names still match.' },
  { title: 'Rerank', icon: ArrowDownUp, Scene: Rerank, caption: 'Reranking the candidates', body: 'A small cross-encoder reads the question next to each candidate and keeps the eight that answer it.' },
  { title: 'Walk the graph', icon: Network, Scene: Graph, caption: 'Walking the call graph', body: 'Callers, callees, base classes and overrides come from the call graph, with their code.' },
  { title: 'Ask for more', icon: PackagePlus, Scene: AskMore, caption: 'Fetching what the model asked for', body: 'If something it needs is missing, the model names it and the code is fetched before it answers.' },
]
