# Codebase RAG

[![CI](https://github.com/CodeBox-commits/git-rag-project/actions/workflows/ci.yml/badge.svg)](https://github.com/CodeBox-commits/git-rag-project/actions/workflows/ci.yml)

Ask questions about any Python, JavaScript or TypeScript repository and get answers that cite the file and line
they came from.

Codebase RAG splits a repository at every function, class and method, links them into a
call graph, and answers questions using hybrid search plus graph traversal. You can also
walk the repository as a 3D city.

![The home page: a sample repository drawn as a neon city, with call arcs between towers](docs/images/hero.png)

## Why not plain RAG?

Most RAG pipelines cut source code into fixed-size chunks. A function ends up split
across two chunks, neither of which makes sense alone, and the retriever has no idea
who calls what.

This project indexes code the way you read it:

- **One chunk per symbol.** Python's `ast` module (and tree-sitter for JS/TS) splits each file at exact function,
  class and method boundaries, so every chunk is a complete unit with its qualified name
  (`InvoiceService.finalize`) and line range.
- **A real call graph.** `self.validate()`, `module.fn()` and `Class()` are resolved to
  their definitions and stored in Neo4j as `CALLS`, `INHERITS` and `HAS_METHOD` edges.
  Calls it can't resolve are left out instead of guessed.
- **Exact names still match.** BM25 keyword search runs next to vector search, so asking
  about `check_totals` finds `check_totals`.
- **Every claim has a source.** The model only sees the retrieved code and graph facts,
  and has to cite `path/to/file.py:line` for each claim.

## What you can do

| Page | What it does |
|---|---|
| **Index** | Paste a public GitHub URL and watch it clone, parse, embed, store and link, with live progress for each stage. |
| **Explore** | Walk the repository as a **code city**: each tower is a function, method or class, as tall as its code is long, standing on its file's plot. Click one to light up its calls. You can switch to a force-directed graph view, filter by file or search by name. |
| **Ask** | Ask in plain English. The answer streams in next to a pipeline inspector, where you can open each step and see the plan, the search queries, the ranked hits, the reranker's reordering and the call tree. |

## Architecture

![Indexing and query pipelines](docs/architecture.png)

**Indexing** runs in a Celery worker, so the UI never blocks:

1. Shallow-clone the repository (`git clone --depth 1`), skipping tests, virtualenvs and `.git`.
2. Parse every `.py` file with `ast` into symbols with exact line spans, and collect call sites.
3. Embed each chunk locally with `BAAI/bge-small-en-v1.5` (384-d, via FastEmbed). Embeddings are cached in Redis, so re-indexing only pays for code that changed.
4. Write vectors to Qdrant, BM25 text to RediSearch, and symbols plus resolved edges to Neo4j, all keyed by the normalised repository URL.

**Every question** runs through a LangGraph state machine:

1. **Plan:** one Gemini call classifies the question, pulls out symbol names and writes up to three search queries.
2. **Route:** lookups walk the graph 1 hop; call-flow, dependency and architecture questions walk 3 hops and use full BM25.
3. **Search:** vector search (top 20 per query) and BM25 (top 20) are merged with Reciprocal Rank Fusion (k = 60) into 24 candidates.
4. **Rerank:** a local cross-encoder (FlashRank `ms-marco-MiniLM-L-12-v2`) keeps the 8 best, blending 0.75 reranker score with 0.25 retrieval score.
5. **Traverse:** Neo4j returns callers, callees, base classes, methods and overrides (same-named methods up and down
   the class hierarchy). The code of up to 6 related symbols the search missed is pulled in too: symbols named in the
   question, overrides of retrieved methods, and direct callees of the top hits.
6. **Answer:** Gemini writes the answer from that context only, with file-and-line citations. Tokens stream to the UI as Server-Sent Events.

## Tech stack

| Layer | Tools |
|---|---|
| API | FastAPI, Server-Sent Events |
| Background jobs | Celery with a Redis broker |
| Agent | LangGraph, Gemini (`gemini-3.5-flash-lite` by default) |
| Parsing | Python `ast`; tree-sitter for JavaScript and TypeScript |
| Embeddings | FastEmbed `bge-small-en-v1.5`, local and free (Gemini embeddings optional) |
| Reranking | FlashRank cross-encoder, local, CPU-only |
| Stores | Neo4j 5 (graph), Qdrant (vectors), Redis Stack / RediSearch (BM25 and cache) |
| Frontend | React 19, TypeScript, Vite, three.js (custom shaders and bloom for the code city) |
| Ops | Docker Compose, GitHub Actions CI, GHCR release images, Caddy for production |

## Quick start

You need Docker and a free [Google AI Studio](https://aistudio.google.com/) API key.
The key is only used to answer questions; indexing runs fully locally.

```bash
git clone https://github.com/CodeBox-commits/git-rag-project.git
cd git-rag-project
cp backend/.env.example backend/.env    # then set GEMINI_API_KEY
docker compose up -d --build
```

Open <http://localhost:8000>, index a repository (for example
`https://github.com/pallets/click`), then explore it or ask a question.

Check that everything is up:

```bash
curl -s localhost:8000/ready
```

Stop it with `docker compose down`. Neo4j and Qdrant data are kept in Docker volumes.

## Configuration

Set these in `backend/.env` (see [`backend/.env.example`](backend/.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | (required) | Planner and answer model |
| `LLM_MODEL` | `gemini-3.5-flash-lite` | Gemini model for planning and answers |
| `EMBEDDING_PROVIDER` | `local` | `local` (free, offline) or `gemini` (768-d, uses your API quota) |
| `VECTOR_TOP_K` | `8` | Chunks kept after reranking |
| `RERANK_CANDIDATES` | `24` | Candidates passed to the reranker |
| `GRAPH_MAX_DEPTH` | `3` | How many calls away graph traversal goes |
| `GRAPH_EXPAND_LIMIT` | `6` | How many related symbols' code the graph step adds to the answer context |
| `RERANKER_MODEL` | `ms-marco-MiniLM-L-12-v2` | Set to `off` to skip reranking |

Each embedding model writes to its own Qdrant collection, so switching provider or model
means re-indexing.

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/repo/index` | Start indexing a repository; returns a task ID |
| `GET` | `/api/v1/repo/status/{task_id}` | Stage, progress and result of an indexing task |
| `GET` | `/api/v1/repo/graph?repo_url=…&limit=…` | Symbols and edges for the Explore page |
| `POST` | `/api/v1/chat/` | Ask a question; set `"stream": true` for Server-Sent Events |
| `GET` | `/api/v1/symbols/definitions?repo_url=…&name=…` | Every symbol with that name: location, class, bases, overrides, direct calls and callers |
| `GET` | `/api/v1/symbols/callers?repo_url=…&name=…&depth=1-5` | Who calls this symbol, up to `depth` hops back |
| `GET` | `/api/v1/symbols/callees?repo_url=…&name=…&depth=1-5` | What this symbol calls, up to `depth` hops forward |
| `GET` | `/health` | Liveness: the process is up |
| `GET` | `/ready` | Readiness: Neo4j, Qdrant and Redis respond |

Interactive docs are at <http://localhost:8000/docs>.

## Development

Run the backend stack with Docker, and the frontend with hot reload:

```bash
docker compose up -d
cd frontend && npm install && npm run dev    # http://localhost:5173, proxies /api to :8000
```

Backend checks (the same ones CI runs):

```bash
cd backend
pip install -r requirements-dev.txt
ruff check . && ruff format --check . && mypy app
pytest                       # unit tests
pytest -m integration        # needs Neo4j, Qdrant and Redis running
```

Frontend checks:

```bash
cd frontend
npx tsc -b && npx oxlint && npm run build
```

CI runs all of these on every pull request, plus a Docker build, deploy-config
validation and secret scanning.

## Project layout

```
backend/
  app/
    api/            FastAPI routes: repo, chat, health
    core/           languages/ (one parser per language), call resolver, schemas
    services/       agent, embeddings, hybrid search, reranker, Neo4j, Qdrant, RediSearch
    workers/        Celery app and the indexing task
  tests/            unit tests, plus integration/ for the full pipeline
frontend/
  src/
    components/     CodeCity (3D city), ForceGraph3D, PipelineInspector, IngestScene
    pages/          Home, Index, Explore, Ask
deploy/             production Compose stack, Caddy, backup and restore scripts
docs/               architecture diagram, deployment runbook
```

## Deployment

Release images are published to GHCR from `main` and from version tags. The production
stack runs behind Caddy with automatic HTTPS, with databases on an internal-only
network. See the [deployment runbook](docs/deploy.md) for setup, upgrades, rollback,
backups and restore.

## Limitations

- Python, JavaScript and TypeScript only. Adding a language is one `Language` subclass
  in `backend/app/core/languages/` plus one line in its registry.
- JS/TS object-literal methods (`{ foo() {} }`) and imports aliased with `as` aren't linked yet.
- Public repositories only (cloned without credentials).
- Calls resolved through dynamic dispatch or external libraries aren't linked in the graph.
