# backend/app/core/parser.py
import ast
from typing import List, Optional
from app.core.schemas import ExtractedChunk

class RepositoryASTVisitor(ast.NodeVisitor):
    def __init__(self, file_path: str, source_lines: List[str]):
        self.file_path = file_path
        self.source_lines = source_lines
        self.chunks: List[ExtractedChunk] = []
        self._current_class: Optional[str] = None

    def _resolve_ast_name(self, node: ast.AST) -> Optional[str]:
        if isinstance(node, ast.Name):
            return node.id
        elif isinstance(node, ast.Attribute):
            prefix = self._resolve_ast_name(node.value)
            return f"{prefix}.{node.attr}" if prefix else node.attr
        elif isinstance(node, ast.Call):
            return self._resolve_ast_name(node.func)
        return None

    def visit_ClassDef(self, node: ast.ClassDef):
        previous_class = self._current_class
        self._current_class = node.name
        self.generic_visit(node)
        self._current_class = previous_class

    def visit_FunctionDef(self, node: ast.FunctionDef):
        self._process_function(node)
        
    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        self._process_function(node)

    def _process_function(self, node: ast.AST):
        start_line = node.lineno
        end_line = getattr(node, "end_lineno", start_line)
        raw_code_slice = "\n".join(self.source_lines[start_line - 1 : end_line])
        
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
                    
            if isinstance(current_node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue

            for child in ast.iter_child_nodes(current_node):
                nodes_to_explore.append(child)

        chunk_type = "method" if self._current_class else "function"

        chunk = ExtractedChunk(
            name=node.name,
            type=chunk_type,
            file_path=self.file_path,
            start_line=start_line,
            end_line=end_line,
            docstring=docstring,
            source_code=raw_code_slice,
            calls=list(set(structural_dependencies)) 
        )
        self.chunks.append(chunk)
        self.generic_visit(node)


class CodeParser:
    @staticmethod
    def parse_python_source(file_path: str, source_text: str) -> List[ExtractedChunk]:
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