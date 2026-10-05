from abc import ABC, abstractmethod
from collections.abc import Mapping
from pathlib import PurePosixPath
from typing import ClassVar

from app.core.schemas import ExtractedChunk


class Language(ABC):
    """Everything the indexer needs to know about one programming language.

    Adding a language means subclassing this in a new module and listing an instance in
    `app/core/languages/__init__.py`. Ingestion, call resolution and storage are generic.
    """

    name: ClassVar[str]
    extensions: ClassVar[tuple[str, ...]]
    # Receivers that refer to the enclosing class instance (`self.x()`, `this.x()`).
    self_names: ClassVar[tuple[str, ...]] = ()
    # File stems that stand for their directory as a module (`__init__.py`, `index.ts`).
    package_stems: ClassVar[tuple[str, ...]] = ()
    # Methods that run when the class is instantiated: `Cls(...)` / `new Cls(...)` calls them.
    constructor_names: ClassVar[tuple[str, ...]] = ()

    def parse(self, file_path: str, source: str) -> list[ExtractedChunk]:
        """Split one file into symbol chunks; return [] for files that don't parse."""
        return unique_qualified_names(self._parse(file_path, source))

    @abstractmethod
    def _parse(self, file_path: str, source: str) -> list[ExtractedChunk]:
        """Language-specific parsing; qualified names may repeat (see unique_qualified_names)."""

    def should_skip(self, path: PurePosixPath) -> bool:
        """Files with a matching extension that still shouldn't be indexed (tests, generated code)."""
        return False

    def module_name(self, file_path: str) -> str:
        """The name other files use to qualify this file's symbols (`utils.helper()`)."""
        path = PurePosixPath(file_path)
        return path.parent.name if path.stem in self.package_stems else path.stem


def unique_qualified_names(chunks: list[ExtractedChunk]) -> list[ExtractedChunk]:
    """Suffix repeated qualified names in one file (`value`, `value#2`, ...), in source order.

    (filepath, qualified_name) identifies a symbol in the graph, so two definitions that
    share a name would otherwise merge into one node: a property and its setter, functions
    defined in both branches of an `if`, or same-named methods of two object literals.
    """
    seen: dict[str, int] = {}
    out = []
    for chunk in chunks:
        count = seen.get(chunk.qualified_name, 0) + 1
        seen[chunk.qualified_name] = count
        out.append(
            chunk if count == 1 else chunk.model_copy(update={"qualified_name": f"{chunk.qualified_name}#{count}"})
        )
    return out


def unalias(ref: str, aliases: Mapping[str, str]) -> str:
    """Rewrite a reference's first segment through the file's import aliases.

    `import { sign as s }` makes `s()` mean `sign()`; `import * as u from './utils'` makes
    `u.check()` mean `utils.check()`, which the resolver matches by module name.
    """
    head, dot, rest = ref.partition(".")
    target = aliases.get(head)
    return f"{target}{dot}{rest}" if target else ref
