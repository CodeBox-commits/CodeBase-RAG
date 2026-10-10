## click (pallets/click)

Indexed commit `2247b35`, labels written for `2247b35`; code `307ebf9`, model `gemini-3.5-flash-lite`, run 2026-10-09T19:15:18+00:00.

### Retrieval

| Variant | Found by search | Kept by rerank | In the context | All gold in context | MRR | Chunks |
|---|---|---|---|---|---|---|
| `full` | 88% | 75% | 83% | 72% | 75% | 11.9 |
| `no_planner` | 84% | 72% | 81% | 68% | 75% | 11.8 |
| `vector_only` | 84% | 73% | 79% | 68% | 75% | 11.7 |
| `bm25_only` | 57% | 53% | 75% | 68% | 46% | 12.1 |
| `no_rerank` | 73% | 73% | 79% | 72% | 57% | 11.4 |
| `no_graph_expansion` | 88% | 75% | 79% | 64% | 75% | 8.0 |

By question kind (`full`):

| Kind | Cases | Found by search | Kept by rerank | In the context | All gold in context | MRR |
|---|---|---|---|---|---|---|
| `architecture` | 1 | 67% | 0% | 0% | 0% | 0% |
| `behaviour` | 15 | 100% | 90% | 90% | 80% | 79% |
| `call_flow` | 4 | 62% | 54% | 67% | 50% | 58% |
| `impact` | 2 | 67% | 50% | 100% | 100% | 100% |
| `lookup` | 3 | 83% | 67% | 83% | 67% | 83% |

Gold code that never reached the model (`full`):

- `script-entry`: missing `src/click/core.py::Command.__call__`, `src/click/core.py::Command.make_context`
- `group-dispatch`: missing `src/click/core.py::Group.resolve_command`, `src/click/core.py::Group.get_command`
- `unknown-subcommand`: missing `src/click/core.py::Group.resolve_command`
- `parsing-to-callback`: missing `src/click/core.py::Command.parse_args`, `src/click/core.py::Parameter.handle_parse_result`, `src/click/parser.py::_OptionParser.parse_args`
- `current-context`: missing `src/click/core.py::Context.__enter__`
- `context-close`: missing `src/click/core.py::Context.__exit__`
- `intrange-clamp`: missing `src/click/types.py::_NumberRangeBase.convert`
