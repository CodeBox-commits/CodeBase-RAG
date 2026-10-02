from app.core.call_resolver import resolve_relationships
from app.core.parser import CodeParser

FILES = {
    "app/utils.py": """
def helper():
    pass

def format_name(x):
    return helper()

def persist(obj):
    obj.save()               # Base.save or Other.save: ambiguous, must not resolve
""",
    "app/models.py": """
from app import utils

class Base:
    def save(self):
        self.validate()

    def validate(self):
        pass

class User(Base):
    def __init__(self):
        self.name = utils.format_name("x")

    def rename(self):
        self.save()          # inherited, defined on Base
        print("renamed")     # builtin, must not resolve

def build():
    return User()
""",
    "app/other.py": """
class Other:
    def save(self):
        pass

def run():
    helper()
""",
}


def _relationships():
    chunks = []
    for path, source in FILES.items():
        chunks.extend(CodeParser.parse_python_source(path, source))
    return resolve_relationships(chunks)


def test_self_calls_resolve_to_the_enclosing_class():
    rel = _relationships()
    assert (("app/models.py", "Base.save"), ("app/models.py", "Base.validate")) in rel.calls


def test_module_qualified_calls_resolve_across_files():
    rel = _relationships()
    assert (("app/models.py", "User.__init__"), ("app/utils.py", "format_name")) in rel.calls


def test_bare_calls_resolve_to_unique_function_and_class_instantiation():
    rel = _relationships()
    assert (("app/utils.py", "format_name"), ("app/utils.py", "helper")) in rel.calls
    assert (("app/other.py", "run"), ("app/utils.py", "helper")) in rel.calls
    assert (("app/models.py", "build"), ("app/models.py", "User")) in rel.calls


def test_inherited_self_call_prefers_candidate_in_same_file():
    rel = _relationships()
    targets = [dst for src, dst in rel.calls if src == ("app/models.py", "User.rename")]
    assert targets == [("app/models.py", "Base.save")]  # not Other.save, not print


def test_ambiguous_and_external_calls_are_dropped():
    rel = _relationships()
    assert [dst for src, dst in rel.calls if src == ("app/utils.py", "persist")] == []


def test_inheritance_and_membership_edges():
    rel = _relationships()
    assert (("app/models.py", "User"), ("app/models.py", "Base")) in rel.inherits
    assert (("app/models.py", "Base"), ("app/models.py", "Base.save")) in rel.has_method
    assert (("app/other.py", "Other"), ("app/other.py", "Other.save")) in rel.has_method
