"""Checks every `path:line` an answer cites against the context the model was actually given.

The prompt tells the model to cite only what it was shown, but nothing enforced it: an
answer could cite a plausible line that was never in the context. Each citation gets a status:

- verified      the cited line was inside code shown to the model
- graph         the location came from graph metadata (callers, impact lists), not shown code
- wrong_line    the file was in the context but the cited line never was
- unknown_file  the file was never in the context at all
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

from app.core.languages import LANGUAGES

CitationStatus = Literal["verified", "graph", "wrong_line", "unknown_file"]

# Longest extensions first so `.tsx` isn't matched as `.ts` + "x".
_EXTENSIONS = sorted({ext.lstrip(".") for lang in LANGUAGES for ext in lang.extensions}, key=len, reverse=True)
# path:line or path:start-end (hyphen or en dash).
CITATION_RE = re.compile(
    r"(?P<path>[\w@.\-/]+\.(?:" + "|".join(_EXTENSIONS) + r")):(?P<start>\d+)(?:\s*[-\u2013]\s*(?P<end>\d+))?"
)


@dataclass(frozen=True)
class Span:
    filepath: str
    start: int
    end: int
    shown: bool  # True: these lines of code were in the prompt; False: only the location was


def snippet_spans(hits: Iterable[dict[str, Any]], max_lines: int) -> list[Span]:
    """Line ranges of code snippets as the prompt shows them (long ones are cut to max_lines)."""
    spans = []
    for hit in hits:
        path, start, end = hit.get("filepath"), hit.get("start_line"), hit.get("end_line")
        if not path or start is None or end is None:
            continue
        shown_lines = len((hit.get("code_text") or "").splitlines()) or (end - start + 1)
        spans.append(Span(path, int(start), int(start) + min(shown_lines, max_lines) - 1, shown=True))
    return spans


def graph_spans(graph_rows: Iterable[dict[str, Any]], impact_reports: Iterable[dict[str, Any]]) -> list[Span]:
    """Locations mentioned in the structural context: symbols, their neighbours, impact lists."""
    spans = []

    def add(path: Any, start: Any, end: Any = None) -> None:
        if path and start is not None:
            spans.append(Span(str(path), int(start), int(end if end is not None else start), shown=False))

    for row in graph_rows:
        add(row.get("filepath"), row.get("start_line"), row.get("end_line"))
        for key in ("calls", "called_by", "overrides", "overridden_by"):
            for item in row.get(key) or []:
                add(item.get("filepath"), item.get("line"))
    for report in impact_reports:
        for item in [*report.get("targets", []), *report.get("affected", [])]:
            add(item.get("filepath"), item.get("start_line"), item.get("end_line"))
    return spans


def _matching_files(cited: str, files: set[str]) -> list[str]:
    # Models often shorten paths: `serializer.py:237` for `src/itsdangerous/serializer.py`.
    cited = cited.lstrip("./")
    return sorted(f for f in files if f == cited or f.endswith("/" + cited))


def check_citations(answer: str, spans: list[Span]) -> list[dict[str, Any]]:
    """One entry per distinct citation in `answer`, in order of first appearance."""
    files = {s.filepath for s in spans}
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for match in CITATION_RE.finditer(answer or ""):
        text = match.group(0)
        if text in seen:
            continue
        seen.add(text)
        start = int(match.group("start"))
        end = int(match.group("end") or start)
        candidates = _matching_files(match.group("path"), files)
        status: CitationStatus = "unknown_file"
        filepath = candidates[0] if candidates else match.group("path")
        if candidates:
            status = "wrong_line"
            covering = [s for s in spans if s.filepath in candidates and s.start <= start <= s.end]
            shown = [s for s in covering if s.shown]
            if shown:
                status, filepath = "verified", shown[0].filepath
            elif covering:
                status, filepath = "graph", covering[0].filepath
        results.append({"text": text, "filepath": filepath, "line": start, "end_line": end, "status": status})
    return results


def summarize(citations: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"total": len(citations), "verified": 0, "graph": 0, "wrong_line": 0, "unknown_file": 0}
    for c in citations:
        counts[c["status"]] += 1
    return counts
