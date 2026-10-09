# Evaluation

Measures how well the pipeline answers questions about a real repository, so a change can be
shown to help (or caught when it hurts). It runs against the real stores and models, not mocks.

## Run it

The stack must be up, with the dataset's repository indexed (`pallets/click` for the default
dataset). Run inside the API container, which has the embedding and reranker models:

```bash
# Every gold symbol exists in the index (no model calls)
docker compose run --rm api python -m eval check --dataset click

# Retrieval: did the right code reach the model? (no model calls: plans are recorded)
docker compose run --rm api python -m eval retrieval --dataset click

# Compare with the saved baseline
docker compose run --rm api python -m eval retrieval --dataset click \
  --baseline eval/baselines/click-retrieval.json

# Answers: ask every question and score the answers (one or two Gemini calls each, paced)
docker compose run --rm api python -m eval answers --dataset click
```

While developing, mount the folder so results land on your machine without a rebuild:
`docker compose run --rm -v "$PWD/backend/eval:/app/eval" api python -m eval ...`. Add
`-e OMP_NUM_THREADS=4` to stop the local models using every core.

Each run writes a JSON file (every case, every stage's hits) and a Markdown summary to
`eval/results/` (git-ignored). Runs worth keeping go in `eval/baselines/`.

## What is measured

**Retrieval**, for each question with gold code:

| Metric | Meaning |
|---|---|
| Found by search | Share of the gold symbols among the fused vector + BM25 candidates (24) |
| Kept by rerank | Share still there after the cross-encoder keeps the best 8 |
| In the context | Share the answer model is shown: reranked hits, code added by the graph step, and symbols listed in an impact report |
| All gold in context | Questions where every gold symbol reached the model |
| MRR | Mean reciprocal rank of the first gold hit after reranking |
| Chunks | Code chunks in the context (cost: more chunks, more input tokens) |

The same questions run through six variants, each switching one stage off, so every stage's
contribution is visible:

| Variant | What changes |
|---|---|
| `full` | Nothing: the pipeline as configured |
| `no_planner` | The raw question is the only query, with no symbols or routing hints |
| `vector_only` | No BM25 |
| `bm25_only` | No vectors; BM25 over every query and field |
| `no_rerank` | No cross-encoder: the first fused results are kept |
| `no_graph_expansion` | The graph step adds no extra code |

**Answers**, from one full run per question:

| Metric | Meaning |
|---|---|
| Citations backed | Share of `file:line` citations the checker marks verified or from the graph |
| Cites the right code | Answers citing a line inside a gold symbol |
| Facts mentioned | Share of the expected facts the answer states (any listed phrasing) |
| Asked for more | Answers where the model requested missing code first |
| Wrongly said "not there" | Answerable questions answered as if the code were missing |
| Unanswerable handled | Questions about things click doesn't do, answered by saying so |

"Facts mentioned" and the abstention checks are string heuristics: cheap and repeatable, but
they can miss a correct answer phrased differently. Read the saved answers before drawing
conclusions from a small change.

## Recorded plans

The planner is the only model call before retrieval. Its output for each question is saved in
`eval/cache/<dataset>-plans.json` and replayed, so retrieval runs are free, repeatable, and
work without an API key. To re-plan (after changing the planner prompt or model), delete the
file and run `retrieval --record`.

## Adding questions or a dataset

Datasets are TOML files in `eval/datasets/` (format in [`dataset.py`](dataset.py)). Write labels
against a fixed commit, put it in `commit`, index that repository, then run `check` to catch
typos in gold symbols. Prefer questions a user would really ask, and gold that is the code an
answer can't be right without, not everything related.
