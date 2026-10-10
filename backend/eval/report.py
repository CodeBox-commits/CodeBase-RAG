"""Markdown tables for a run, optionally with the change from a baseline run."""

from typing import Any

RETRIEVAL_COLUMNS = [
    ("candidate_recall", "Found by search"),
    ("reranked_recall", "Kept by rerank"),
    ("context_recall", "In the context"),
    ("all_gold_in_context", "All gold in context"),
    ("reciprocal_rank", "MRR"),
    ("context_chunks", "Chunks"),
]

ANSWER_COLUMNS = [
    ("citation_validity", "Citations backed"),
    ("cites_gold", "Cites the right code"),
    ("mention", "Facts mentioned"),
    ("asked_for_more", "Asked for more"),
    ("false_abstention", 'Wrongly said "not there"'),
    ("correct_abstention", "Unanswerable handled"),
    ("seconds", "Seconds"),
]

_COUNTS = {"context_chunks", "seconds"}
# Lower is better for these; the others are better higher.
_LOWER_IS_BETTER = {"false_abstention", "seconds", "context_chunks"}


def _cell(key: str, value: Any, base: Any = None) -> str:
    if value is None:
        return "n/a"
    text = f"{value:.1f}" if key in _COUNTS else f"{value:.0%}"
    if base is None:
        return text
    delta = value - base
    if abs(delta) < 1e-9:
        return text
    sign = "+" if delta > 0 else "-"
    amount = f"{abs(delta):.1f}" if key in _COUNTS else f"{abs(delta) * 100:.0f} pts"
    better = (delta < 0) == (key in _LOWER_IS_BETTER)
    return f"{text} ({sign}{amount}{'' if better else ' ⚠'})"


def _table(header: list[str], rows: list[list[str]]) -> str:
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    lines += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(lines)


def retrieval_markdown(run: dict[str, Any], baseline: dict[str, Any] | None = None) -> str:
    base = (baseline or {}).get("retrieval", {}).get("variants", {})
    rows = []
    for name, v in run["retrieval"]["variants"].items():
        s, b = v["summary"], base.get(name, {}).get("summary", {})
        rows.append([f"`{name}`", *(_cell(k, s.get(k), b.get(k) if base else None) for k, _ in RETRIEVAL_COLUMNS)])
    out = [_table(["Variant", *(label for _, label in RETRIEVAL_COLUMNS)], rows)]

    full = run["retrieval"]["variants"].get("full")
    if full:
        kinds = [
            [f"`{k}`", str(int(s["cases"])), *(_cell(c, s.get(c)) for c, _ in RETRIEVAL_COLUMNS[:5])]
            for k, s in full["by_kind"].items()
        ]
        out += [
            "",
            "By question kind (`full`):",
            "",
            _table(["Kind", "Cases", *(label for _, label in RETRIEVAL_COLUMNS[:5])], kinds),
        ]
        misses = [
            f"- `{c['id']}`: missing {', '.join(f'`{m}`' for m in c['missing'])}" for c in full["cases"] if c["missing"]
        ]
        if misses:
            out += ["", "Gold code that never reached the model (`full`):", "", *misses]
    return "\n".join(out)


def answers_markdown(run: dict[str, Any], baseline: dict[str, Any] | None = None) -> str:
    s = run["answers"]["summary"]
    b = (baseline or {}).get("answers", {}).get("summary", {}) if baseline else {}
    row = [_cell(k, s.get(k), b.get(k) if b else None) for k, _ in ANSWER_COLUMNS]
    cases = f"{int(s.get('cases', 0))} answerable, {s.get('unanswerable_cases', 0)} unanswerable"
    return f"{cases}\n\n" + _table([label for _, label in ANSWER_COLUMNS], [row])


def markdown(run: dict[str, Any], baseline: dict[str, Any] | None = None) -> str:
    m = run["meta"]
    head = [
        f"## {m['dataset']} ({m['repo'].removeprefix('https://github.com/')})",
        "",
        f"Indexed commit `{(m.get('indexed_commit') or '?')[:7]}`, labels written for `{(m.get('labelled_commit') or '?')[:7]}`; "
        f"code `{m.get('code_version') or '?'}`, model `{m['llm_model']}`, run {m['ran_at']}.",
    ]
    if m.get("indexed_commit") and m.get("labelled_commit") and m["indexed_commit"] != m["labelled_commit"]:
        head.append(
            "\n> The indexed commit differs from the one the labels were written for; some gold symbols may have moved."
        )
    parts = ["\n".join(head)]
    if "retrieval" in run:
        parts.append("### Retrieval\n\n" + retrieval_markdown(run, baseline))
    if "answers" in run:
        parts.append("### Answers\n\n" + answers_markdown(run, baseline))
    return "\n\n".join(parts) + "\n"
