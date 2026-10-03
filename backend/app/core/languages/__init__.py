"""Registry of supported languages.

To add a language: write a `Language` subclass in its own module and add an instance below.
Nothing else in ingestion, call resolution or storage needs to change.
"""

from collections.abc import Iterator
from pathlib import Path, PurePosixPath

from app.core.languages.base import Language
from app.core.languages.javascript import JavaScriptLanguage, TypeScriptLanguage
from app.core.languages.python import PythonLanguage
from app.core.schemas import ExtractedChunk

LANGUAGES: tuple[Language, ...] = (
    PythonLanguage(),
    JavaScriptLanguage(),
    TypeScriptLanguage(),
)

_BY_NAME = {lang.name: lang for lang in LANGUAGES}
_BY_EXTENSION = {ext: lang for lang in LANGUAGES for ext in lang.extensions}

# Directories that never hold the project's own source, whatever the language.
SKIP_DIRS = frozenset(
    {
        ".git",
        ".venv",
        "venv",
        "node_modules",
        "dist",
        "build",
        "out",
        "coverage",
        "vendor",
        "tests",
        "test",
        "__tests__",
        "__pycache__",
    }
)


def get_language(name: str) -> Language:
    return _BY_NAME[name]


def language_for_path(path: str | PurePosixPath) -> Language | None:
    """The language that handles this file, or None if it isn't indexed."""
    pure = PurePosixPath(path)
    lang = _BY_EXTENSION.get(pure.suffix)
    if lang is None or lang.should_skip(pure):
        return None
    return lang


def discover_source_files(root: Path) -> Iterator[tuple[Path, Language]]:
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if not path.is_file() or SKIP_DIRS.intersection(relative.parts[:-1]):
            continue
        lang = language_for_path(relative.as_posix())
        if lang is not None:
            yield path, lang


def parse_source(file_path: str, source: str) -> list[ExtractedChunk]:
    """Parse a file with whichever language its extension belongs to."""
    lang = language_for_path(file_path)
    return lang.parse(file_path, source) if lang is not None else []


__all__ = ["LANGUAGES", "Language", "discover_source_files", "get_language", "language_for_path", "parse_source"]
