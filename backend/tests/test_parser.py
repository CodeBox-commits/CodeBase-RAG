from app.core.languages import parse_source

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
    chunks = _by_qname(parse_source("pkg/models.py", SOURCE))

    assert "Base.__init__" in chunks
    assert "Child.__init__" in chunks
    assert chunks["Base.__init__"].name == "__init__"
    assert chunks["Base.__init__"].start_line != chunks["Child.__init__"].start_line


def test_class_chunks_are_emitted_with_header_and_bases():
    chunks = _by_qname(parse_source("pkg/models.py", SOURCE))

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
    chunks = _by_qname(parse_source("pkg/models.py", SOURCE))

    assert chunks["Child.name"].type == "method"
    assert chunks["Child.name.helper"].type == "function"
    assert chunks["main"].type == "function"


def test_calls_include_decorators_and_attribute_chains_but_not_nested_bodies():
    chunks = _by_qname(parse_source("pkg/models.py", SOURCE))

    assert "self.setup" in chunks["Base.__init__"].calls
    assert "property" in chunks["Child.name"].calls
    assert "helper" in chunks["Child.name"].calls
    # os.path.join belongs to the nested helper, not to the method that defines it.
    assert "os.path.join" not in chunks["Child.name"].calls
    assert "os.path.join" in chunks["Child.name.helper"].calls
    assert {"Child", "child.run"} <= set(chunks["main"].calls)


def test_invalid_or_empty_source_yields_no_chunks():
    assert parse_source("x.py", "") == []
    assert parse_source("x.py", "def broken(:\n") == []


def test_overload_stubs_are_skipped_and_the_implementation_kept():
    source = """
import typing as t
from typing import overload

class Signer:
    @t.overload
    def unsign(self, value: str, ts: t.Literal[False] = False) -> bytes: ...
    @overload
    def unsign(self, value: str, ts: t.Literal[True]) -> tuple[bytes, int]: ...
    def unsign(self, value, ts=False):
        return self.verify(value)
"""
    chunks = [c for c in parse_source("signer.py", source) if c.qualified_name == "Signer.unsign"]
    assert len(chunks) == 1
    assert chunks[0].start_line == 10 and chunks[0].calls == ["self.verify"]


def test_python_import_aliases_and_duplicate_names():
    source = """
import numpy as np
from app.utils import format_name as fmt
import app.models as m

class Box(m.Base):
    @property
    def size(self):
        return fmt(np.ones(3))

    @size.setter
    def size(self, value):
        self._size = value
"""
    chunks = {c.qualified_name: c for c in parse_source("app/box.py", source)}
    assert chunks["Box"].bases == ["models.Base"]
    assert chunks["Box.size"].calls == ["format_name", "numpy.ones", "property"]
    # The setter shares the getter's name: it gets its own node instead of merging into it.
    assert "Box.size#2" in chunks and chunks["Box.size#2"].start_line > chunks["Box.size"].start_line
