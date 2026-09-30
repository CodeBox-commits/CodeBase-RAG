from app.core.parser import CodeParser

SOURCE = '''
import os

class Base:
    """Base docstring."""
    kind = "base"

    def __init__(self):
        self.setup()

    def setup(self):
        pass


class Child(Base, mixins.Loggable):
    def __init__(self):
        super().__init__()

    @property
    def name(self):
        def helper():
            return os.path.join("a", "b")
        return helper()


class Box(Generic[T]):
    pass


async def main():
    child = Child()
    await child.run()
'''


def _by_qname(chunks):
    return {c.qualified_name: c for c in chunks}


def test_same_named_methods_get_distinct_qualified_names():
    chunks = _by_qname(CodeParser.parse_python_source("pkg/models.py", SOURCE))

    assert "Base.__init__" in chunks
    assert "Child.__init__" in chunks
    assert chunks["Base.__init__"].name == "__init__"
    assert chunks["Base.__init__"].start_line != chunks["Child.__init__"].start_line


def test_class_chunks_are_emitted_with_header_and_bases():
    chunks = _by_qname(CodeParser.parse_python_source("pkg/models.py", SOURCE))

    base = chunks["Base"]
    assert base.type == "class"
    assert base.docstring == "Base docstring."
    # Header only: stops before the first method.
    assert 'kind = "base"' in base.source_code
    assert "def __init__" not in base.source_code
    assert base.end_line >= chunks["Base.setup"].end_line

    assert chunks["Child"].bases == ["Base", "mixins.Loggable"]
    assert chunks["Box"].bases == ["Generic"]


def test_nested_function_in_method_is_a_function_not_a_method():
    chunks = _by_qname(CodeParser.parse_python_source("pkg/models.py", SOURCE))

    assert chunks["Child.name"].type == "method"
    assert chunks["Child.name.helper"].type == "function"
    assert chunks["main"].type == "function"


def test_calls_include_decorators_and_attribute_chains_but_not_nested_bodies():
    chunks = _by_qname(CodeParser.parse_python_source("pkg/models.py", SOURCE))

    assert "self.setup" in chunks["Base.__init__"].calls
    assert "property" in chunks["Child.name"].calls
    assert "helper" in chunks["Child.name"].calls
    # os.path.join belongs to the nested helper, not to the method that defines it.
    assert "os.path.join" not in chunks["Child.name"].calls
    assert "os.path.join" in chunks["Child.name.helper"].calls
    assert {"Child", "child.run"} <= set(chunks["main"].calls)


def test_invalid_or_empty_source_yields_no_chunks():
    assert CodeParser.parse_python_source("x.py", "") == []
    assert CodeParser.parse_python_source("x.py", "def broken(:\n") == []
