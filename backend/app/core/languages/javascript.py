"""JavaScript and TypeScript, parsed with tree-sitter.

Both languages share one walker: TypeScript's grammar is a superset of JavaScript's,
so the node types for functions, classes, methods and calls are the same.
"""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import ClassVar, Literal

import tree_sitter_javascript
import tree_sitter_typescript
from tree_sitter import Language as Grammar
from tree_sitter import Node, Parser

from app.core.languages.base import Language
from app.core.schemas import ExtractedChunk

ChunkType = Literal["function", "method", "class"]

_CLASS_NODES = {"class_declaration", "abstract_class_declaration", "class"}
_FUNCTION_NODES = {"function_declaration", "generator_function_declaration"}
_FUNCTION_VALUES = {"arrow_function", "function_expression", "function", "generator_function"}
_FIELD_NODES = {"public_field_definition", "field_definition"}

# Generated or vendored code: huge, and never what a question is about.
_MAX_FILE_BYTES = 500_000
_SKIP_SUFFIXES = (".min.js", ".d.ts", ".bundle.js")
_TEST_MARKERS = (".test.", ".spec.")


@dataclass(frozen=True)
class _Definition:
    name: str
    kind: ChunkType
    node: Node  # the whole definition, for line range and source
    body: Node | None  # where calls are collected


def _text(node: Node | None) -> str:
    return node.text.decode("utf-8", "replace") if node is not None and node.text is not None else ""


def _reference_name(node: Node | None) -> str | None:
    """Dotted name of a callee or base class: `a.b.c`, `this.run`, `Base`."""
    if node is None:
        return None
    if node.type in ("identifier", "property_identifier", "type_identifier", "private_property_identifier"):
        return _text(node)
    if node.type in ("this", "super"):
        return node.type
    if node.type == "member_expression":
        prefix = _reference_name(node.child_by_field_name("object"))
        prop = _text(node.child_by_field_name("property"))
        return f"{prefix}.{prop}" if prefix else prop
    if node.type in ("call_expression", "new_expression"):
        # mix(Base) / factory()() -> the callee
        return _reference_name(node.child_by_field_name("function") or node.child_by_field_name("constructor"))
    if node.type in ("parenthesized_expression", "non_null_expression", "generic_type"):
        return _reference_name(node.named_children[0]) if node.named_children else None
    return None


class _Walker:
    def __init__(self, file_path: str, language: str, source: str):
        self.file_path = file_path
        self.language = language
        self.lines = source.splitlines()
        self.chunks: list[ExtractedChunk] = []

    def definition(self, node: Node, in_class: bool) -> _Definition | None:
        if node.type in _CLASS_NODES:
            name = node.child_by_field_name("name")
            return _Definition(_text(name), "class", node, None) if name is not None else None

        if node.type in _FUNCTION_NODES:
            name = node.child_by_field_name("name")
            if name is None:
                return None
            return _Definition(
                _text(name), "method" if in_class else "function", node, node.child_by_field_name("body")
            )

        if node.type == "method_definition":
            return _Definition(
                _text(node.child_by_field_name("name")), "method", node, node.child_by_field_name("body")
            )

        if node.type in _FIELD_NODES and in_class:
            # `handle = () => {...}` inside a class body behaves like a method.
            value = node.child_by_field_name("value")
            name = node.child_by_field_name("name") or node.child_by_field_name("property")
            if value is not None and value.type in _FUNCTION_VALUES and name is not None:
                return _Definition(_text(name), "method", node, value.child_by_field_name("body"))

        if node.type == "variable_declarator":
            # `const handler = () => {...}` / `= function () {...}`
            value = node.child_by_field_name("value")
            name = node.child_by_field_name("name")
            if value is not None and value.type in _FUNCTION_VALUES and name is not None and name.type == "identifier":
                # A single `const x = ...` is shown whole, keyword included.
                parent = node.parent
                whole = parent if parent is not None and parent.named_child_count == 1 else node
                return _Definition(_text(name), "function", whole, value.child_by_field_name("body"))

        return None

    def walk(self, root: Node) -> None:
        # Iterative: deeply nested expressions in large files would overflow Python's recursion limit.
        stack: list[tuple[Node, tuple[tuple[str, str], ...]]] = [(root, ())]
        while stack:
            node, scope = stack.pop()
            parent = node.parent
            in_class = bool(scope) and scope[-1][1] == "class" and parent is not None and parent.type == "class_body"
            found = self.definition(node, in_class)
            if found is not None and found.name:
                self.emit(found, scope)
                scope = (*scope, (found.name, "class" if found.kind == "class" else "function"))
            stack.extend((child, scope) for child in reversed(node.named_children))

    def emit(self, d: _Definition, scope: tuple[tuple[str, str], ...]) -> None:
        start = d.node.start_point.row + 1
        end = d.node.end_point.row + 1
        qualified = ".".join([name for name, _ in scope] + [d.name])

        if d.kind == "class":
            calls, bases = [], self.bases(d.node)
            # Members are chunked separately, so the class chunk only carries the header.
            header_end = end
            body = d.node.child_by_field_name("body")
            for member in body.named_children if body is not None else []:
                if self.definition(member, in_class=True) is not None:
                    header_end = max(start, member.start_point.row)
                    break
        else:
            calls, bases, header_end = self.calls(d.body), [], end

        self.chunks.append(
            ExtractedChunk(
                name=d.name,
                qualified_name=qualified,
                type=d.kind,
                file_path=self.file_path,
                language=self.language,
                start_line=start,
                end_line=end,
                docstring=self.docstring(d.node),
                source_code="\n".join(self.lines[start - 1 : header_end]).rstrip(),
                calls=calls,
                bases=bases,
            )
        )

    def calls(self, body: Node | None) -> list[str]:
        found: set[str] = set()
        stack = [body] if body is not None else []
        while stack:
            node = stack.pop()
            if node.type == "call_expression":
                name = _reference_name(node.child_by_field_name("function"))
                if name:
                    # A bare `super(...)` in a constructor calls the base class constructor.
                    found.add("super.constructor" if name == "super" else name)
            elif node.type == "new_expression":
                name = _reference_name(node.child_by_field_name("constructor"))
                if name:
                    found.add(name)
            for child in node.named_children:
                # Named nested definitions are their own chunks; anonymous callbacks
                # (`items.map(x => f(x))`) belong to the enclosing function.
                if self.definition(child, in_class=False) is None:
                    stack.append(child)
        return sorted(found)

    @staticmethod
    def bases(class_node: Node) -> list[str]:
        bases: list[str] = []
        for heritage in (c for c in class_node.named_children if c.type == "class_heritage"):
            for clause in heritage.named_children:
                if clause.type == "implements_clause":
                    continue
                # TypeScript wraps the base in extends_clause; JavaScript doesn't.
                target = clause.child_by_field_name("value") if clause.type == "extends_clause" else clause
                name = _reference_name(target)
                if name:
                    bases.append(name)
        return bases

    @staticmethod
    def docstring(node: Node) -> str | None:
        # JSDoc sits right before the definition, or before the `export` wrapping it.
        anchor = node.parent if node.parent is not None and node.parent.type == "export_statement" else node
        comment = anchor.prev_named_sibling
        if comment is None or comment.type != "comment" or comment.end_point.row < anchor.start_point.row - 1:
            return None
        text = _text(comment)
        if not text.startswith("/**"):
            return None
        lines = [line.strip().lstrip("*").strip() for line in text[3:-2].splitlines()]
        return "\n".join(line for line in lines if line) or None


class _TreeSitterLanguage(Language):
    package_stems = ("index",)
    self_names = ("this",)
    constructor_names = ("constructor",)
    # Grammar per extension (TSX and JSX need the JSX-aware grammars).
    grammars: ClassVar[dict[str, Callable[[], object]]]

    def __init__(self) -> None:
        self._parsers: dict[str, Parser] = {}

    def _parser(self, suffix: str) -> Parser:
        if suffix not in self._parsers:
            self._parsers[suffix] = Parser(Grammar(self.grammars[suffix]()))
        return self._parsers[suffix]

    def should_skip(self, path: PurePosixPath) -> bool:
        name = path.name
        return name.endswith(_SKIP_SUFFIXES) or any(marker in name for marker in _TEST_MARKERS)

    def parse(self, file_path: str, source: str) -> list[ExtractedChunk]:
        if not source.strip() or len(source) > _MAX_FILE_BYTES:
            return []
        suffix = PurePosixPath(file_path).suffix
        tree = self._parser(suffix).parse(source.encode("utf-8"))
        walker = _Walker(file_path, self.name, source)
        walker.walk(tree.root_node)
        return walker.chunks


class JavaScriptLanguage(_TreeSitterLanguage):
    name = "javascript"
    extensions = (".js", ".jsx", ".mjs", ".cjs")
    grammars: ClassVar[dict[str, Callable[[], object]]] = dict.fromkeys(extensions, tree_sitter_javascript.language)


class TypeScriptLanguage(_TreeSitterLanguage):
    name = "typescript"
    extensions = (".ts", ".tsx", ".mts", ".cts")
    grammars: ClassVar[dict[str, Callable[[], object]]] = {
        ".ts": tree_sitter_typescript.language_typescript,
        ".mts": tree_sitter_typescript.language_typescript,
        ".cts": tree_sitter_typescript.language_typescript,
        ".tsx": tree_sitter_typescript.language_tsx,
    }
