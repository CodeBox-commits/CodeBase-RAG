import { useEffect, useMemo, useState } from 'react'
import CodeCity from '../components/CodeCity'
import { sampleCity } from '../sampleCity'

const PIPELINE = [
  { id: 'plan', label: 'Plan', desc: 'One model call works out what kind of question it is, pulls out any symbol names and writes up to three search queries.' },
  { id: 'route', label: 'Route', desc: 'Lookups go straight to search. Questions about call flow or dependencies also walk the graph.' },
  { id: 'retrieve', label: 'Search', desc: 'Vector search for each query and BM25 keyword search run side by side, then merge by rank into 24 candidates.' },
  { id: 'rerank', label: 'Rerank', desc: 'A small cross-encoder reads the question next to each candidate and keeps the 8 that answer it best.' },
  { id: 'traverse', label: 'Traverse', desc: 'For the symbols found, Neo4j returns callers and callees up to three calls away, plus base classes and methods.' },
  { id: 'answer', label: 'Answer', desc: 'The model sees only that code and those relationships, and cites a file and line for each claim.' },
]

function Pipeline() {
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setActive((a) => (a + 1) % PIPELINE.length), 3200)
    return () => clearInterval(id)
  }, [paused])

  return (
    <div className="pipeline" onMouseLeave={() => setPaused(false)}>
      <ol className="pipeline-steps">
        {PIPELINE.map((p, i) => (
          <li key={p.id}>
            <button
              className={`pipeline-step ${i === active ? 'active' : ''} ${i < active ? 'done' : ''}`}
              aria-pressed={i === active}
              onMouseEnter={() => { setPaused(true); setActive(i) }}
              onFocus={() => { setPaused(true); setActive(i) }}
              onClick={() => { setPaused(true); setActive(i) }}
            >
              <span className="pipeline-n">{i + 1}</span>
              {p.label}
            </button>
          </li>
        ))}
      </ol>
      <p className="pipeline-detail" key={active} aria-live="polite">{PIPELINE[active].desc}</p>
    </div>
  )
}

export default function Home() {
  const city = useMemo(() => sampleCity(), [])

  return (
    <>
      <header className="hero">
        <CodeCity nodes={city.nodes} edges={city.edges} controls={false} tour offsetX={0.2} className="hero-city" />
        <div className="hero-copy">
          <h1><span>Ask your codebase.</span> <span>Get answers with file and line.</span></h1>
          <p className="hero-sub">
            Point it at a Python, JavaScript or TypeScript repository. It splits the code at every function and class, maps
            who calls whom, and answers questions with citations you can open.
          </p>
          <div className="hero-actions">
            <a href="#/index" className="btn btn-primary">Index a repository</a>
            <a href="#how" className="btn btn-quiet" onClick={(e) => { e.preventDefault(); document.getElementById('how')?.scrollIntoView() }}>
              How a question is answered
            </a>
          </div>
        </div>
        <p className="hero-key">
          A sample repository as a city: each tower is a <i className="k-fn">function</i>, <i className="k-m">method</i> or{' '}
          <i className="k-cls">class</i>, as tall as its code is long, standing on its file. Lit arcs are calls.
        </p>
      </header>

      <main>
        <section className="section split" id="why">
          <div className="rail">
            <h2>Text splitters cut functions in half</h2>
            <p className="lede">Most RAG pipelines chop source into fixed-size pieces. A function ends up split across two chunks, and neither one makes sense alone.</p>
          </div>
          <div className="compare">
            <figure className="compare-pane">
              <figcaption>Fixed-size chunks</figcaption>
              <pre className="code">
<span className="c-kw">def</span> <span className="c-fn">finalize</span>(self, invoice):{'\n'}
{'    '}self.validate(invoice){'\n'}
{'    '}total = self._total(invoice)
<span className="cut" role="presentation">chunk 14 ends at 500 characters</span>
{'    '}<span className="c-kw">if</span> total &gt; invoice.limit:{'\n'}
{'        '}<span className="c-kw">raise</span> <span className="c-cls">LimitExceeded</span>(total){'\n'}
{'    '}<span className="c-kw">return</span> self.gateway.charge(total)
              </pre>
            </figure>
            <figure className="compare-pane good">
              <figcaption>One chunk per symbol</figcaption>
              <pre className="code">
<span className="c-cm"># InvoiceService.finalize{'\n'}# billing/service.py:42–48</span>{'\n'}
<span className="c-kw">def</span> <span className="c-fn">finalize</span>(self, invoice):{'\n'}
{'    '}self.validate(invoice){'\n'}
{'    '}total = self._total(invoice){'\n'}
{'    '}<span className="c-kw">if</span> total &gt; invoice.limit:{'\n'}
{'        '}<span className="c-kw">raise</span> <span className="c-cls">LimitExceeded</span>(total){'\n'}
{'    '}<span className="c-kw">return</span> self.gateway.charge(total)
              </pre>
            </figure>
          </div>
          <dl className="facts">
            <div>
              <dt>Calls are resolved, not guessed</dt>
              <dd><code>self.validate()</code> links to <code>BaseService.validate</code>. Calls it can't resolve are left out instead of invented.</dd>
            </div>
            <div>
              <dt>Exact names still match</dt>
              <dd>Keyword search runs next to vector search, so asking about <code>check_totals</code> finds <code>check_totals</code>.</dd>
            </div>
            <div>
              <dt>Every claim has a source</dt>
              <dd>Answers point to <code>path/to/file.py:line</code>, so you can check them in your editor.</dd>
            </div>
          </dl>
        </section>

        <section className="section split" id="how">
          <div className="rail">
            <h2>How a question is answered</h2>
            <p className="lede">Six steps run for every question. On the Ask page you can open each one and see what it found.</p>
          </div>
          <Pipeline />
        </section>

        <section className="section split" id="stores">
          <div className="rail">
            <h2>Three indexes, one answer</h2>
            <p className="lede">Indexing writes each repository to three stores, each keyed by its URL.</p>
          </div>
          <dl className="stores">
            <div><dt><i className="k-cls" />Neo4j</dt><dd>Symbols and the calls, inheritance and methods between them.</dd></div>
            <div><dt><i className="k-m" />Qdrant</dt><dd>A vector for every chunk, for searching by meaning.</dd></div>
            <div><dt><i className="k-fn" />RediSearch</dt><dd>BM25 over names, paths and source text, for exact matches.</dd></div>
          </dl>
        </section>

        <section className="section closer">
          <h2>Start with a repository you know well</h2>
          <p className="lede">You'll be able to tell right away whether the answers are right.</p>
          <nav className="closer-links" aria-label="Get started">
            <a href="#/index"><strong>Index</strong><span>Paste a GitHub URL and watch each stage run.</span></a>
            <a href="#/explore"><strong>Explore</strong><span>Walk the repository as a city or a call graph.</span></a>
            <a href="#/ask"><strong>Ask</strong><span>Ask in plain English and inspect every step.</span></a>
          </nav>
        </section>
      </main>

      <footer className="footer">
        <span className="footer-brand">Codebase RAG</span>
        <span className="muted">Built with FastAPI, Celery, LangGraph, Neo4j, Qdrant, RediSearch and three.js.</span>
      </footer>
    </>
  )
}
