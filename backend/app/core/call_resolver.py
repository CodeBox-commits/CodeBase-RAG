from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Dict, Iterable, List, Optional, Set, Tuple

from app.core.schemas import ExtractedChunk

# (filepath, qualified_name) uniquely identifies a symbol within a repository.
SymbolKey = Tuple[str, str]
Edge = Tuple[SymbolKey, SymbolKey]


@dataclass
class Relationships:
    calls: List[Edge] = field(default_factory=list)
    inherits: List[Edge] = field(default_factory=list)
    has_method: List[Edge] = field(default_factory=list)


def _key(chunk: ExtractedChunk) -> SymbolKey:
    return (chunk.file_path, chunk.qualified_name)


def _parent_name(chunk: ExtractedChunk) -> Optional[str]:
    parts = chunk.qualified_name.split(".")
    return parts[-2] if len(parts) > 1 else None


def _module_name(chunk: ExtractedChunk) -> str:
    path = PurePosixPath(chunk.file_path)
    return path.parent.name if path.stem == "__init__" else path.stem


class _SymbolIndex:
    def __init__(self, chunks: Iterable[ExtractedChunk]):
        self.by_key: Dict[SymbolKey, ExtractedChunk] = {}
        self.by_name: Dict[str, List[ExtractedChunk]] = defaultdict(list)
        for chunk in chunks:
            self.by_key[_key(chunk)] = chunk
            self.by_name[chunk.name].append(chunk)

    def enclosing_class(self, chunk: ExtractedChunk) -> Optional[str]:
        """Qualified name of the nearest class around `chunk` (what `self` refers to)."""
        parts = chunk.qualified_name.split(".")[:-1]
        while parts:
            candidate = self.by_key.get((chunk.file_path, ".".join(parts)))
            if candidate is not None and candidate.type == "class":
                return candidate.qualified_name
            parts.pop()
        return None

    def resolve(self, ref: str, source: ExtractedChunk, kinds: Set[str]) -> Optional[SymbolKey]:
        """Best-effort static resolution of a call/base reference to a definition.

        Returns None when the reference is external (stdlib, third party) or ambiguous,
        so the graph only ever contains edges between symbols that exist in the repo.
        """
        parts = ref.split(".")
        name = parts[-1]
        candidates = [c for c in self.by_name.get(name, []) if c.type in kinds]
        if not candidates:
            return None

        if len(parts) == 1:
            # A bare name can't refer to a method.
            pool = [c for c in candidates if c.type != "method"]
        elif parts[0] in ("self", "cls") and len(parts) == 2:
            owner = self.enclosing_class(source)
            if owner:
                own_key = (source.file_path, f"{owner}.{name}")
                if own_key in self.by_key:
                    return own_key
            # Probably inherited from a base class defined elsewhere.
            pool = [c for c in candidates if c.type == "method"]
        else:
            # `Class.method(...)` or `module.func(...)`.
            qualifier = parts[-2]
            exact = [
                c for c in candidates
                if _parent_name(c) == qualifier or _module_name(c) == qualifier
            ]
            if len(exact) == 1:
                return _key(exact[0])
            pool = exact or candidates

        same_file = [c for c in pool if c.file_path == source.file_path]
        if len(same_file) == 1:
            return _key(same_file[0])
        if len(pool) == 1:
            return _key(pool[0])
        return None


def resolve_relationships(chunks: List[ExtractedChunk]) -> Relationships:
    index = _SymbolIndex(chunks)
    rel = Relationships()

    for chunk in chunks:
        key = _key(chunk)

        if chunk.type == "method":
            owner = (chunk.file_path, chunk.qualified_name.rsplit(".", 1)[0])
            if owner in index.by_key:
                rel.has_method.append((owner, key))

        if chunk.type == "class":
            for base in chunk.bases:
                target = index.resolve(base, chunk, {"class"})
                if target and target != key:
                    rel.inherits.append((key, target))
            continue

        for call in chunk.calls:
            target = index.resolve(call, chunk, {"function", "method", "class"})
            if target and target != key:
                rel.calls.append((key, target))

    rel.calls = sorted(set(rel.calls))
    rel.inherits = sorted(set(rel.inherits))
    rel.has_method = sorted(set(rel.has_method))
    return rel
