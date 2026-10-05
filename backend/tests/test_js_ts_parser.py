from app.core.call_resolver import resolve_relationships
from app.core.languages import language_for_path, parse_source

TS_SOURCE = """
import { hash } from "./crypto";

/**
 * Signs and verifies values.
 */
export abstract class Signer<T> extends Base implements Verifier {
  algorithm = "sha256";

  constructor(private key: string) {
    super(key);
  }

  sign(value: string): string {
    return this.digest(value) + hash(value);
  }

  private digest = (value: string) => {
    return [value].map((v) => encode(v)).join("");
  };
}

export class TimedSigner extends Signer<string> {
  sign(value: string): string {
    return super.sign(value) + Date.now();
  }
}

export function makeSigner(key: string) {
  function inner() {
    return new TimedSigner(key);
  }
  return inner();
}

export const verify = async (token: string) => utils.check(token);
"""

JSX_SOURCE = """
const App = () => {
  const [count, setCount] = useState(0);
  return <Button onClick={() => setCount(count + 1)} />;
};

class Button extends React.Component {
  render() { return <button>{this.props.label}</button>; }
}

module.exports = { App };
"""


def _by_qname(path, source):
    return {c.qualified_name: c for c in parse_source(path, source)}


def test_typescript_symbols_and_kinds():
    chunks = _by_qname("src/signer.ts", TS_SOURCE)
    assert {q: c.type for q, c in chunks.items()} == {
        "Signer": "class",
        "Signer.constructor": "method",
        "Signer.sign": "method",
        "Signer.digest": "method",
        "TimedSigner": "class",
        "TimedSigner.sign": "method",
        "makeSigner": "function",
        "makeSigner.inner": "function",
        "verify": "function",
    }
    assert all(c.language == "typescript" for c in chunks.values())


def test_typescript_bases_skip_implements_and_generics():
    chunks = _by_qname("src/signer.ts", TS_SOURCE)
    assert chunks["Signer"].bases == ["Base"]
    assert chunks["TimedSigner"].bases == ["Signer"]


def test_calls_include_this_new_super_and_anonymous_callbacks():
    chunks = _by_qname("src/signer.ts", TS_SOURCE)
    assert chunks["Signer.sign"].calls == ["hash", "this.digest"]
    assert "encode" in chunks["Signer.digest"].calls  # inside an anonymous arrow callback
    assert chunks["TimedSigner.sign"].calls == ["Date.now", "super.sign"]
    assert chunks["Signer.constructor"].calls == ["super.constructor"]
    assert chunks["makeSigner"].calls == ["inner"]  # the nested function's own calls stay with it
    assert chunks["makeSigner.inner"].calls == ["TimedSigner"]
    assert chunks["verify"].calls == ["utils.check"]


def test_class_chunk_is_header_only_and_jsdoc_is_extracted():
    signer = _by_qname("src/signer.ts", TS_SOURCE)["Signer"]
    assert signer.docstring == "Signs and verifies values."
    assert "algorithm" in signer.source_code
    assert "sign(value" not in signer.source_code
    assert signer.end_line > signer.start_line + 10


def test_jsx_components():
    chunks = _by_qname("web/App.jsx", JSX_SOURCE)
    assert chunks["App"].type == "function"
    assert chunks["App"].source_code.startswith("const App")
    assert "useState" in chunks["App"].calls and "setCount" in chunks["App"].calls
    assert chunks["Button"].bases == ["React.Component"]
    assert chunks["Button.render"].type == "method"
    assert chunks["Button"].language == "javascript"


def test_tsx_parses_with_the_tsx_grammar():
    chunks = _by_qname("web/App.tsx", JSX_SOURCE.replace("(0)", "<number>(0)"))
    assert "App" in chunks and "Button.render" in chunks


def test_file_selection():
    assert language_for_path("src/a.ts").name == "typescript"
    assert language_for_path("src/a.mjs").name == "javascript"
    for skipped in ("types/index.d.ts", "dist/app.min.js", "src/a.test.ts", "src/a.spec.jsx", "README.md"):
        assert language_for_path(skipped) is None


def test_cross_file_resolution_for_typescript():
    files = {
        "src/utils/index.ts": "export function check(t: string) { return t; }",
        "src/signer.ts": TS_SOURCE,
        "src/base.ts": "export class Base { digest() {} }",
        "src/py_twin.py": "def check(t):\n    return t\n",
    }
    chunks = [c for path, src in files.items() for c in parse_source(path, src)]
    rel = resolve_relationships(chunks)

    assert (("src/signer.ts", "Signer.sign"), ("src/signer.ts", "Signer.digest")) in rel.calls
    # `utils.check` -> utils/index.ts (index stands for its folder), never the Python twin
    assert (("src/signer.ts", "verify"), ("src/utils/index.ts", "check")) in rel.calls
    assert (("src/signer.ts", "TimedSigner"), ("src/signer.ts", "Signer")) in rel.inherits
    assert (("src/signer.ts", "Signer"), ("src/base.ts", "Base")) in rel.inherits
    assert (("src/signer.ts", "Signer"), ("src/signer.ts", "Signer.sign")) in rel.has_method
    # super.sign() in the subclass reaches the base class's method
    assert (("src/signer.ts", "TimedSigner.sign"), ("src/signer.ts", "Signer.sign")) in rel.calls
