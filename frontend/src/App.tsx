import { useEffect, useState } from 'react'
import GraphScene from './components/GraphScene'
import OrbitScene from './components/OrbitScene'
import Workspace from './Workspace'

/** Adds `.in` to every `.reveal` element once it scrolls into view. */
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll('.reveal')
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            io.unobserve(e.target)
          }
        }),
      { threshold: 0.15 },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])
}

function useScrolled() {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  return scrolled
}

const STEPS = [
  {
    n: '01',
    title: 'Clone',
    body: 'A Celery worker shallow-clones the repository out of band, so the UI never blocks.',
    code: 'git clone --depth 1',
  },
  {
    n: '02',
    title: 'Parse the AST',
    body: 'Every class, method and nested function becomes a chunk with a qualified name and exact line range.',
    code: 'InvoiceService.finalize  L42–58',
  },
  {
    n: '03',
    title: 'Embed & index',
    body: 'Chunks are embedded into Qdrant and indexed for BM25 in RediSearch, one repo at a time.',
    code: '768-d · cosine · BM25STD',
  },
  {
    n: '04',
    title: 'Link the graph',
    body: 'Calls, inheritance and membership are statically resolved into real Neo4j edges.',
    code: '(:Method)-[:CALLS]->(:Function)',
  },
]

const PIPELINE = [
  { id: 'analyze', label: 'Analyze', desc: 'Classifies intent (symbol lookup, call flow, architecture, bug…) and extracts named symbols.' },
  { id: 'rewrite', label: 'Rewrite', desc: 'Produces up to three retrieval-optimised queries that keep every symbol verbatim.' },
  { id: 'route', label: 'Route', desc: 'Chooses vector, hybrid or graph-heavy retrieval based on the question type.' },
  { id: 'retrieve', label: 'Retrieve', desc: 'Multi-query vector search fused with BM25 via Reciprocal Rank Fusion.' },
  { id: 'traverse', label: 'Traverse', desc: 'Walks callers and callees up to three hops, plus class, base and method relations.' },
  { id: 'answer', label: 'Answer', desc: 'Grounded generation that must cite path/to/file.py:line for every claim.' },
]

function Pipeline() {
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    const id = setInterval(() => setActive((a) => (a + 1) % PIPELINE.length), 2200)
    return () => clearInterval(id)
  }, [paused])

  return (
    <div className="pipeline reveal" onMouseLeave={() => setPaused(false)}>
      <div className="pipeline-track">
        <div className="pipeline-progress" style={{ width: `${(active / (PIPELINE.length - 1)) * 100}%` }} />
        {PIPELINE.map((p, i) => (
          <button
            key={p.id}
            className={`pipeline-node ${i === active ? 'active' : ''} ${i < active ? 'done' : ''}`}
            onMouseEnter={() => {
              setPaused(true)
              setActive(i)
            }}
            onFocus={() => {
              setPaused(true)
              setActive(i)
            }}
          >
            <span className="pipeline-dot" />
            <span className="pipeline-label">{p.label}</span>
          </button>
        ))}
      </div>
      <div className="pipeline-detail" key={active}>
        <span className="mono accent">step {active + 1} / {PIPELINE.length}</span>
        <h3>{PIPELINE[active].label}</h3>
        <p>{PIPELINE[active].desc}</p>
      </div>
    </div>
  )
}

export default function App() {
  useReveal()
  const scrolled = useScrolled()

  return (
    <>
      <nav className={`nav ${scrolled ? 'scrolled' : ''}`}>
        <a href="#top" className="nav-brand">
          <span className="nav-logo" aria-hidden>
            <svg viewBox="0 0 24 24" width="16" height="16">
              <circle cx="6" cy="6" r="2.4" />
              <circle cx="18" cy="8" r="2.4" />
              <circle cx="10" cy="18" r="2.4" />
              <path d="M6 6 L18 8 L10 18 Z" fill="none" strokeWidth="1.4" />
            </svg>
          </span>
          Codebase<span className="accent">RAG</span>
        </a>
        <div className="nav-links">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#pipeline">Pipeline</a>
          <a href="#stack">Stack</a>
        </div>
        <a href="#workspace" className="btn btn-primary btn-sm">Open workspace</a>
      </nav>

      <header id="top" className="hero">
        <GraphScene className="hero-canvas" />
        <div className="hero-vignette" />
        <div className="hero-content">
          <div className="eyebrow rise" style={{ animationDelay: '0ms' }}>
            <span className="live-dot" /> AST · Knowledge graph · Hybrid search
          </div>
          <h1 className="rise" style={{ animationDelay: '90ms' }}>
            Ask your codebase.<br />
            <span className="gradient-text">Get answers with receipts.</span>
          </h1>
          <p className="hero-sub rise" style={{ animationDelay: '180ms' }}>
            Point it at any Python repository. It parses every function and class, maps who calls whom,
            and answers questions with file-and-line citations instead of guesses.
          </p>
          <div className="hero-ctas rise" style={{ animationDelay: '270ms' }}>
            <a href="#workspace" className="btn btn-primary">Index a repository →</a>
            <a href="#how" className="btn btn-ghost">See how it works</a>
          </div>
          <dl className="hero-stats rise" style={{ animationDelay: '360ms' }}>
            <div><dt>3</dt><dd>stores fused</dd></div>
            <div><dt>3-hop</dt><dd>call traversal</dd></div>
            <div><dt>RRF</dt><dd>rank fusion</dd></div>
            <div><dt>file:line</dt><dd>citations</dd></div>
          </dl>
        </div>
        <a href="#how" className="scroll-cue" aria-label="Scroll down"><span /></a>
      </header>

      <main>
        <section id="how" className="section">
          <div className="section-head reveal">
            <span className="kicker">How it works</span>
            <h2>From <span className="mono">git clone</span> to a queryable graph in four steps</h2>
          </div>
          <ol className="steps-grid">
            {STEPS.map((s, i) => (
              <li key={s.n} className="step-card reveal" style={{ transitionDelay: `${i * 90}ms` }}>
                <span className="step-n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <code className="step-code">{s.code}</code>
              </li>
            ))}
          </ol>
        </section>

        <section id="features" className="section">
          <div className="section-head reveal">
            <span className="kicker">Why not plain RAG</span>
            <h2>Naive text splitting cuts functions in half. This doesn't.</h2>
          </div>
          <div className="bento">
            <article className="bento-card span-2 reveal">
              <h3>Structure-aware chunks</h3>
              <p>Chunks follow the AST, not a character count. Same-named methods never collide.</p>
              <pre className="code-demo">
<span className="c-kw">class</span> <span className="c-cls">InvoiceService</span>(<span className="c-cls">BaseService</span>):{'\n'}
{'    '}<span className="c-kw">def</span> <span className="c-fn">finalize</span>(self, invoice):   <span className="c-cm"># → InvoiceService.finalize</span>{'\n'}
{'        '}self.validate(invoice){'\n'}
{'        '}<span className="c-kw">def</span> <span className="c-fn">_total</span>():            <span className="c-cm"># → InvoiceService.finalize._total</span>{'\n'}
{'            '}...
              </pre>
            </article>
            <article className="bento-card reveal">
              <div className="bento-icon">⟳</div>
              <h3>Resolved call graph</h3>
              <p><span className="mono">self.x()</span>, <span className="mono">module.fn()</span> and <span className="mono">Class()</span> resolve to real definitions. Ambiguous or external calls are dropped rather than invented.</p>
            </article>
            <article className="bento-card reveal">
              <div className="bento-icon">⌕</div>
              <h3>Hybrid retrieval</h3>
              <p>Several query embeddings plus BM25, merged with Reciprocal Rank Fusion. An exact symbol name always ranks first.</p>
            </article>
            <article className="bento-card span-2 reveal">
              <h3>Grounded answers</h3>
              <p>The model only sees retrieved code and graph facts, and must cite them.</p>
              <div className="answer-demo">
                <span className="demo-tag">example</span>
                <p><span className="mono accent">InvoiceService</span> is defined in <code>billing/service.py:18</code> and extends <code>BaseService</code>.</p>
                <p><span className="mono">finalize</span> calls <code>BaseService.validate</code> → <code>rules.check_totals</code> (2 hops) and is called by <code>api.checkout</code>.</p>
              </div>
            </article>
            <article className="bento-card reveal">
              <div className="bento-icon">◎</div>
              <h3>Query understanding</h3>
              <p>Questions are classified and rewritten first, so "what calls X" walks the graph while "where is X" looks up the symbol.</p>
            </article>
            <article className="bento-card reveal">
              <div className="bento-icon">⇅</div>
              <h3>Background ingestion</h3>
              <p>Cloning, parsing and embedding run in a Celery worker, with live progress and failures that say why they failed.</p>
            </article>
            <article className="bento-card reveal">
              <div className="bento-icon">▦</div>
              <h3>Per-repo isolation</h3>
              <p>Every store is keyed by a normalized repo URL, so <span className="mono">.git</span> and trailing slashes never split an index.</p>
            </article>
          </div>
        </section>

        <section id="pipeline" className="section">
          <div className="section-head reveal">
            <span className="kicker">Agent pipeline</span>
            <h2>A LangGraph state machine behind every question</h2>
          </div>
          <Pipeline />
        </section>

        <section id="stack" className="section stack">
          <div className="stack-copy reveal">
            <span className="kicker">Three stores, one answer</span>
            <h2>Graph, vectors and keywords, orbiting a single query</h2>
            <ul className="stack-list">
              <li><span className="swatch" style={{ background: '#3ee6c1' }} /><div><strong>Neo4j</strong> holds symbols and their CALLS, INHERITS and HAS_METHOD edges.</div></li>
              <li><span className="swatch" style={{ background: '#7c9cff' }} /><div><strong>Qdrant</strong> holds a 768-d embedding for every chunk, filtered per repository.</div></li>
              <li><span className="swatch" style={{ background: '#ff8fa3' }} /><div><strong>RediSearch</strong> runs BM25 over symbols, paths and source text.</div></li>
            </ul>
            <p className="muted">Orchestrated by FastAPI, Celery and LangGraph, with Gemini for embeddings and generation.</p>
          </div>
          <OrbitScene className="orbit-canvas reveal" />
        </section>

        <section id="workspace" className="section workspace-section">
          <div className="section-head reveal">
            <span className="kicker">Workspace</span>
            <h2>Index a repository and start asking</h2>
          </div>
          <div className="workspace-frame reveal">
            <Workspace />
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>Codebase<span className="accent">RAG</span></span>
        <span className="muted">FastAPI · Celery · Neo4j · Qdrant · RediSearch · LangGraph · Gemini · three.js</span>
      </footer>
    </>
  )
}
