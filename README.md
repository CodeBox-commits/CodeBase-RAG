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
| **Index** | Paste a public GitHub URL and watch it clone, parse, embed, store and link, with live progress for each stage. **Update** re-embeds only the files that changed since the last run; **Full rebuild** redoes everything. |
| **Explore** | Walk the repository as an **architectural massing model** in axonometric: each block is a function (white card), method (grey board) or class (basswood), as tall as its code is long, standing on its file's plot. Click one to pin it and draw its calls as threads, or ask **"What breaks if this changes?"** to light up its whole blast radius (callers, subclasses and overrides, up to 3 hops) with a per-file list. You can switch to a force-directed graph view, filter by file or search by name. |
| **MCP** | Coding agents (Claude Code, Cursor and others) use the same code intelligence as tools: see [MCP server](#mcp-server). |
| **Ask** | Ask in plain English, and follow up ("and what calls it?"). The answer streams in token by token next to a pipeline inspector, where you can open each step and see the plan, the search queries, the ranked hits, the reranker's reordering and the call tree. Every `file:line` citation is a chip marked verified or unverified; click it to open that code. |

Press <kbd>⌘K</kbd> (or <kbd>Ctrl K</kbd>) anywhere to jump to a page, switch repository or find a symbol. The UI has a
light theme (drafting film) and a dark one (a cyanotype of the same drawing), and follows your system setting by default.

## Architecture

![Indexing and query pipelines](docs/architecture.png)

**Indexing** runs in a Celery worker, so the UI never blocks:

1. Shallow-clone the repository (`git clone --depth 1`), skipping tests, virtualenvs, `node_modules` and `.git`.
2. Compare each file's git blob hash with the last run: only **new or changed** files go on to be embedded and
   stored; deleted files are removed. An unchanged commit returns "up to date" at once.
3. Parse every Python, JavaScript and TypeScript file into symbols with exact line spans and call sites. All files
   are parsed (it's cheap), so calls between changed and unchanged files resolve correctly.
4. Embed the changed chunks locally with `BAAI/bge-small-en-v1.5` (384-d, via FastEmbed).
5. Swap each changed file's old vectors (Qdrant), BM25 entries (RediSearch) and symbols (Neo4j) for the new ones once
   they're ready, so the repository never goes empty; then re-link every call and inheritance edge. A file that fails
   keeps its old data and is retried next run. `"full": true`, or a parser change (`INDEX_VERSION`), rebuilds everything.

**Every question** runs through a LangGraph state machine:

1. **Plan:** one Gemini call classifies the question, pulls out symbol names and writes up to three search queries.
2. **Route:** lookups walk the graph 1 hop; call-flow, dependency and architecture questions walk 3 hops and use full BM25.
   "What breaks if I change X?" questions also get X's exact blast radius from the graph.
3. **Search:** vector search (top 20 per query) and BM25 (top 20) are merged with Reciprocal Rank Fusion (k = 60) into 24 candidates.
4. **Rerank:** a local cross-encoder (FlashRank `ms-marco-MiniLM-L-12-v2`) keeps the 8 best, blending 0.75 reranker score with 0.25 retrieval score.
5. **Traverse:** Neo4j returns callers, callees, base classes, methods and overrides (same-named methods up and down
   the class hierarchy). The code of up to 6 related symbols the search missed is pulled in too: symbols named in the
   question, overrides of retrieved methods, and direct callees of the top hits.
6. **Ask for more (optional):** if code it needs isn't in the context, the model replies `NEED: <names>` instead of
   guessing; those symbols are fetched (exact lookup, then search) and it answers. One round, never shown to the user,
   and skippable per question (`allow_followup: false`, or the toggle under the Ask box).
7. **Answer:** Gemini writes the answer from that context only, with file-and-line citations. Tokens stream to the UI as
   Server-Sent Events. If the model is rate-limited, `LLM_FALLBACK_MODEL` is tried; with no model at all, the answer
   lists the retrieved code instead of failing.
8. **Check citations:** every `path:line` in the answer is matched against what the model was shown: *verified* (the
   line was in shown code), *graph* (a location from the call graph), or unverified (*wrong line* / *unknown file*).

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
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, shadcn/ui (Radix), Motion, Shiki, cmdk, three.js (the repository as an architectural massing model) |
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
| `LLM_FALLBACK_MODEL` | (unset) | Tried for answers when `LLM_MODEL` is rate-limited or overloaded |
| `AGENT_FOLLOWUP_ROUNDS` | `1` | How many times the model may ask for missing code; `0` turns ask-for-more off |
| `EMBEDDING_PROVIDER` | `local` | `local` (free, offline) or `gemini` (768-d, uses your API quota) |
| `VECTOR_TOP_K` | `8` | Chunks kept after reranking |
| `RERANK_CANDIDATES` | `24` | Candidates passed to the reranker |
| `GRAPH_MAX_DEPTH` | `3` | How many calls away graph traversal goes |
| `GRAPH_EXPAND_LIMIT` | `6` | How many related symbols' code the graph step adds to the answer context |
| `RERANKER_MODEL` | `ms-marco-MiniLM-L-12-v2` | Set to `off` to skip reranking |
| `MCP_TOKEN` | (unset) | Bearer token required on `/mcp`; unset means no auth, fine on localhost only |
| `MCP_ALLOWED_HOSTS` | `localhost:*,127.0.0.1:*,[::1]:*` | `Host` headers the MCP endpoint answers |

Each embedding model writes to its own Qdrant collection, so switching provider or model
means re-indexing.

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/repo/index` | Index or update a repository (only changed files; `"full": true` rebuilds); returns a task ID |
| `GET` | `/api/v1/repo/status/{task_id}` | Stage, progress and result of an indexing task |
| `GET` | `/api/v1/repo/list` | Every indexed repository with its symbol count |
| `DELETE` | `/api/v1/repo?repo_url=…` | Remove a repository's vectors, BM25 entries and graph |
| `GET` | `/api/v1/repo/graph?repo_url=…&limit=…` | Symbols and edges for the Explore page |
| `POST` | `/api/v1/chat/` | Ask a question (`"stream"`, `"history"` for follow-ups, `"allow_followup"`); SSE when streaming |
| `GET` | `/api/v1/symbols/definitions?repo_url=…&name=…` | Every symbol with that name: location, class, bases, overrides, direct calls and callers |
| `GET` | `/api/v1/symbols/callers?repo_url=…&name=…&depth=1-5` | Who calls this symbol, up to `depth` hops back |
| `GET` | `/api/v1/symbols/callees?repo_url=…&name=…&depth=1-5` | What this symbol calls, up to `depth` hops forward |
| `GET` | `/api/v1/symbols/impact?repo_url=…&name=…&depth=1-5` | Blast radius: everything that calls, subclasses or overrides it, grouped by file |
| `GET` | `/api/v1/symbols/at?repo_url=…&filepath=…&line=…` | The function, method or class containing that line, with its code |
| `POST` | `/mcp` | MCP server (streamable HTTP) |
| `GET` | `/health` | Liveness: the process is up |
| `GET` | `/ready` | Readiness: Neo4j, Qdrant and Redis respond |

Interactive docs are at <http://localhost:8000/docs>.

## MCP server

The code intelligence is also an [MCP](https://modelcontextprotocol.io) server at `/mcp`,
so a coding agent can look things up in an indexed repository while it works. Add it to
Claude Code:

```bash
claude mcp add --transport http codebox http://localhost:8000/mcp
```

| Tool | What it returns |
|---|---|
| `list_repositories` | Indexed repositories (the `repo_url` every other tool takes) |
| `search_code` | Hybrid vector + BM25 search, reranked, with each hit's code |
| `find_definition` | Location, class, bases, subclasses, overrides, direct calls and callers |
| `get_symbol_code` | A symbol's full source |
| `get_code_at` | The symbol containing a `file:line`, with its code (to check a citation) |
| `find_callers` / `find_callees` | Call graph neighbours up to 5 hops away |
| `impact_of` | Blast radius of changing a symbol, grouped by file |
| `ask_codebase` | A cited answer from the full RAG pipeline, each citation with its check status (uses Gemini quota) |

All tools except `ask_codebase` are exact graph or search lookups: no LLM calls, no quota.
The server is stateless and returns plain JSON. It only answers requests whose `Host` is in
`MCP_ALLOWED_HOSTS` (protection against DNS rebinding), and when `MCP_TOKEN` is set every call
needs `Authorization: Bearer <token>`. The production stack requires a token:

```bash
claude mcp add --transport http codebox https://your.domain/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

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
npx tsc -b && npx oxlint && npm test && npm run build
```

CI runs all of these on every pull request, plus a Docker build, deploy-config
validation and secret scanning.

## Project layout

```
backend/
  app/
    api/            FastAPI routes: repo, chat, symbols (code intelligence), health
    mcp_server.py   MCP tools over the same code-intelligence layer
    core/           languages/ (one parser per language), call resolver, schemas
    services/       code_intel (definitions, callers, impact, search), agent, embeddings,
                    hybrid search, reranker, Neo4j, Qdrant, RediSearch
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
- Default imports (`import x from './m'`) aren't mapped to the exported name; named, namespace
  and `require` imports are. Same-named definitions in one file are kept apart as `name`, `name#2`.
- Public repositories only (cloned without credentials).
- Calls resolved through dynamic dispatch or external libraries aren't linked in the graph.
