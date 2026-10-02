# backend/app/core/parser.py
import ast

from app.core.schemas import ExtractedChunk

_DEFINITION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


class RepositoryASTVisitor(ast.NodeVisitor):
    def __init__(self, file_path: str, source_lines: list[str]):
        self.file_path = file_path
        self.source_lines = source_lines
        self.chunks: list[ExtractedChunk] = []
        # Enclosing definitions as (name, kind) pairs, kind being "class" or "function".
        self._scope: list[tuple[str, str]] = []

    def _resolve_ast_name(self, node: ast.AST) -> str | None:
        if isinstance(node, ast.Name):
            return node.id
        elif isinstance(node, ast.Attribute):
            prefix = self._resolve_ast_name(node.value)
            return f"{prefix}.{node.attr}" if prefix else node.attr
        elif isinstance(node, ast.Call):
            return self._resolve_ast_name(node.func)
        elif isinstance(node, ast.Subscript):
            # Generic[T] -> Generic
            return self._resolve_ast_name(node.value)
        return None

    def _qualify(self, name: str) -> str:
        return ".".join([scope_name for scope_name, _ in self._scope] + [name])

    def _slice(self, start_line: int, end_line: int) -> str:
        return "\n".join(self.source_lines[start_line - 1 : end_line])

    def visit_ClassDef(self, node: ast.ClassDef):
        start_line = node.lineno
        end_line = getattr(node, "end_lineno", start_line)

        # Methods are chunked separately, so the class chunk only carries the header:
        # signature, docstring and class-level attributes up to the first nested definition.
        header_end = end_line
        for child in node.body:
            if isinstance(child, _DEFINITION_NODES):
                first_line = min([child.lineno] + [d.lineno for d in child.decorator_list])
                header_end = max(start_line, first_line - 1)
                break

        bases = [b for b in (self._resolve_ast_name(base) for base in node.bases) if b]
        decorators = [d for d in (self._resolve_ast_name(dec) for dec in node.decorator_list) if d]

        self.chunks.append(
            ExtractedChunk(
                name=node.name,
                qualified_name=self._qualify(node.name),
                type="class",
                file_path=self.file_path,
                start_line=start_line,
                end_line=end_line,
                docstring=ast.get_docstring(node),
                source_code=self._slice(start_line, header_end).rstrip(),
                calls=sorted(set(decorators)),
                bases=bases,
            )
        )

        self._scope.append((node.name, "class"))
        self.generic_visit(node)
        self._scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef):
        self._process_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        self._process_function(node)

    def _process_function(self, node: ast.AST):
        start_line = node.lineno
        end_line = getattr(node, "end_lineno", start_line)
        raw_code_slice = self._slice(start_line, end_line)

        docstring = ast.get_docstring(node)

        structural_dependencies = []

        if hasattr(node, "decorator_list"):
            for decorator_node in node.decorator_list:
                resolved_decorator = self._resolve_ast_name(decorator_node)
                if resolved_decorator:
                    structural_dependencies.append(resolved_decorator)

        nodes_to_explore = list(node.body)
        while nodes_to_explore:
            current_node = nodes_to_explore.pop(0)

            if isinstance(current_node, ast.Call):
                resolved_call = self._resolve_ast_name(current_node.func)
                if resolved_call:
                    structural_dependencies.append(resolved_call)

            if isinstance(current_node, _DEFINITION_NODES):
                continue

            for child in ast.iter_child_nodes(current_node):
                nodes_to_explore.append(child)

        # Only a definition directly inside a class body is a method; a function nested
        # inside a method is a plain (nested) function.
        is_method = bool(self._scope) and self._scope[-1][1] == "class"
        chunk_type = "method" if is_method else "function"

        chunk = ExtractedChunk(
            name=node.name,
            qualified_name=self._qualify(node.name),
            type=chunk_type,
            file_path=self.file_path,
            start_line=start_line,
            end_line=end_line,
            docstring=docstring,
            source_code=raw_code_slice,
            calls=sorted(set(structural_dependencies)),
        )
        self.chunks.append(chunk)

        self._scope.append((node.name, "function"))
        self.generic_visit(node)
        self._scope.pop()


class CodeParser:
    @staticmethod
    def parse_python_source(file_path: str, source_text: str) -> list[ExtractedChunk]:
        if not source_text.strip():
            return []

        try:
            syntax_tree = ast.parse(source_text)
        except (SyntaxError, ValueError):
            return []

        source_lines = source_text.splitlines()
        visitor = RepositoryASTVisitor(file_path, source_lines)
        visitor.visit(syntax_tree)

        return visitor.chunks
