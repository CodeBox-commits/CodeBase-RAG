from abc import ABC, abstractmethod
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

    @abstractmethod
    def parse(self, file_path: str, source: str) -> list[ExtractedChunk]:
        """Split one file into symbol chunks; return [] for files that don't parse."""

    def should_skip(self, path: PurePosixPath) -> bool:
        """Files with a matching extension that still shouldn't be indexed (tests, generated code)."""
        return False

    def module_name(self, file_path: str) -> str:
        """The name other files use to qualify this file's symbols (`utils.helper()`)."""
        path = PurePosixPath(file_path)
        return path.parent.name if path.stem in self.package_stems else path.stem
