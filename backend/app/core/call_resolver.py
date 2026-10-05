from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field

from app.core.languages import get_language
from app.core.schemas import ExtractedChunk

# (filepath, qualified_name) uniquely identifies a symbol within a repository.
SymbolKey = tuple[str, str]
Edge = tuple[SymbolKey, SymbolKey]


@dataclass
class Relationships:
    calls: list[Edge] = field(default_factory=list)
    inherits: list[Edge] = field(default_factory=list)
    has_method: list[Edge] = field(default_factory=list)


def _key(chunk: ExtractedChunk) -> SymbolKey:
    return (chunk.file_path, chunk.qualified_name)


def _parent_name(chunk: ExtractedChunk) -> str | None:
    parts = chunk.qualified_name.split(".")
    return parts[-2] if len(parts) > 1 else None


def _module_name(chunk: ExtractedChunk) -> str:
    return get_language(chunk.language).module_name(chunk.file_path)


class _SymbolIndex:
    def __init__(self, chunks: Iterable[ExtractedChunk]):
        self.by_key: dict[SymbolKey, ExtractedChunk] = {}
        self.by_name: dict[str, list[ExtractedChunk]] = defaultdict(list)
        for chunk in chunks:
            self.by_key[_key(chunk)] = chunk
            self.by_name[chunk.name].append(chunk)

    def enclosing_class(self, chunk: ExtractedChunk) -> str | None:
        """Qualified name of the nearest class around `chunk` (what `self`/`this` refers to)."""
        parts = chunk.qualified_name.split(".")[:-1]
        while parts:
            candidate = self.by_key.get((chunk.file_path, ".".join(parts)))
            if candidate is not None and candidate.type == "class":
                return candidate.qualified_name
            parts.pop()
        return None

    def resolve_super(self, name: str, source: ExtractedChunk, max_levels: int = 5) -> SymbolKey | None:
        """`super().name()` / `super.name()`: the nearest base class (breadth-first) defining `name`."""
        owner = self.enclosing_class(source)
        if owner is None:
            return None
        level = [self.by_key[(source.file_path, owner)]]
        visited: set[SymbolKey] = set()
        for _ in range(max_levels):
            next_level = []
            for cls in level:
                for base in cls.bases:
                    target = self.resolve(base, cls, {"class"})
                    if target is None or target in visited:
                        continue
                    visited.add(target)
                    method = (target[0], f"{target[1]}.{name}")
                    if method in self.by_key:
                        return method
                    next_level.append(self.by_key[target])
            if not next_level:
                return None
            level = next_level
        return None

    def resolve(self, ref: str, source: ExtractedChunk, kinds: set[str]) -> SymbolKey | None:
        """Best-effort static resolution of a call/base reference to a definition.

        Returns None when the reference is external (stdlib, third party) or ambiguous,
        so the graph only ever contains edges between symbols that exist in the repo.
        """
        parts = ref.split(".")
        name = parts[-1]
        if parts[0] == "super" and len(parts) == 2:
            # Python's super().x() and JS/TS super.x() both reach the base class's method.
            return self.resolve_super(name, source)
        # Calls never cross languages (a JS frontend doesn't call the Python backend directly).
        candidates = [c for c in self.by_name.get(name, []) if c.type in kinds and c.language == source.language]
        if not candidates:
            return None

        if len(parts) == 1:
            # A bare name can't refer to a method.
            pool = [c for c in candidates if c.type != "method"]
        elif parts[0] in get_language(source.language).self_names and len(parts) == 2:
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
            exact = [c for c in candidates if _parent_name(c) == qualifier or _module_name(c) == qualifier]
            if len(exact) == 1:
                return _key(exact[0])
            pool = exact or candidates

        same_file = [c for c in pool if c.file_path == source.file_path]
        if len(same_file) == 1:
            return _key(same_file[0])
        if len(pool) == 1:
            return _key(pool[0])
        return None


def resolve_relationships(chunks: list[ExtractedChunk]) -> Relationships:
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
