"""Evaluation datasets: hand-labelled questions about one indexed repository.

A dataset is a TOML file in eval/datasets/:

    repo = "https://github.com/pallets/click"
    commit = "2247b35..."          # the commit the labels were written against

    [[case]]
    id = "standalone-mode"
    kind = "behaviour"             # see KINDS
    question = "What does standalone_mode=False change in Command.main?"
    gold = ["src/click/core.py::Command.main"]
    mention = [["propagat", "re-raise"], ["return value"]]

`gold` is the code an answer can't be right without: each entry is `path::Qualified.name`
(or just `Qualified.name` for any file). `mention` lists facts a correct answer states; each
fact is a list of alternative phrasings, matched case-insensitively. Unanswerable questions
set `answerable = false` and leave `gold` empty: the right answer says the code isn't there.
"""

import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DATASETS = Path(__file__).parent / "datasets"

KINDS = ("lookup", "behaviour", "call_flow", "impact", "architecture", "unanswerable")


@dataclass(frozen=True)
class Gold:
    """One symbol a correct answer depends on."""

    name: str
    filepath: str | None = None

    @classmethod
    def parse(cls, spec: str) -> "Gold":
        path, sep, name = spec.rpartition("::")
        return cls(name=name, filepath=path if sep else None)

    def __str__(self) -> str:
        return f"{self.filepath}::{self.name}" if self.filepath else self.name


@dataclass(frozen=True)
class Case:
    id: str
    kind: str
    question: str
    gold: tuple[Gold, ...] = ()
    mention: tuple[tuple[str, ...], ...] = ()
    answerable: bool = True


@dataclass(frozen=True)
class Dataset:
    name: str
    repo: str
    commit: str | None
    cases: tuple[Case, ...] = field(default_factory=tuple)


def load(name: str) -> Dataset:
    """Loads eval/datasets/<name>.toml (or a path) and checks it is well-formed."""
    path = Path(name) if name.endswith(".toml") else DATASETS / f"{name}.toml"
    raw = tomllib.loads(path.read_text())
    cases = tuple(_case(c) for c in raw.get("case", []))
    ids = [c.id for c in cases]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise ValueError(f"{path.name}: duplicate case ids {duplicates}")
    return Dataset(name=path.stem, repo=raw["repo"], commit=raw.get("commit"), cases=cases)


def _case(raw: dict) -> Case:
    case_id = raw["id"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", case_id):
        raise ValueError(f"case id {case_id!r}: use lowercase letters, digits and dashes")
    kind = raw["kind"]
    if kind not in KINDS:
        raise ValueError(f"{case_id}: kind {kind!r} is not one of {KINDS}")
    answerable = raw.get("answerable", kind != "unanswerable")
    gold = tuple(Gold.parse(g) for g in raw.get("gold", []))
    if answerable and not gold:
        raise ValueError(f"{case_id}: an answerable case needs at least one gold symbol")
    mention = tuple(tuple(m) if isinstance(m, list) else (m,) for m in raw.get("mention", []))
    return Case(
        id=case_id, kind=kind, question=raw["question"].strip(), gold=gold, mention=mention, answerable=answerable
    )
