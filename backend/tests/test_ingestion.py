import pytest

from app.core.schemas import ExtractedChunk
from app.services.embeddings import EmbeddingDimensionError
from app.workers.tasks import IngestionError, embed_chunks


def _chunk(name, path):
    return ExtractedChunk(name=name, qualified_name=name, file_path=path,
                          start_line=1, end_line=2, source_code=f"def {name}(): pass")


class FakeEmbedder:
    def __init__(self, fail_on=None, error=RuntimeError):
        self.batches = []
        self.fail_on = fail_on
        self.error = error

    def embed_documents(self, texts):
        self.batches.append(list(texts))
        if self.fail_on is not None and len(self.batches) - 1 == self.fail_on:
            raise self.error("quota")
        return [[float(len(text))] for text in texts]


def _files():
    return [
        ("a.py", [_chunk("a1", "a.py"), _chunk("a22", "a.py")]),
        ("b.py", [_chunk("b333", "b.py")]),
        ("c.py", [_chunk("c4444", "c.py")]),
    ]


def test_chunks_from_many_files_share_a_batch_and_stay_aligned():
    embedder = FakeEmbedder()
    vectors, failed = embed_chunks(embedder, _files(), batch_size=100)

    assert len(embedder.batches) == 1
    assert failed == set()
    assert vectors["a.py"] == [[len("def a1(): pass")], [len("def a22(): pass")]]
    assert vectors["c.py"] == [[len("def c4444(): pass")]]


def test_a_failed_batch_only_fails_the_files_it_touched():
    # Batches: [a1, a22] [b333, c4444]
    vectors, failed = embed_chunks(FakeEmbedder(fail_on=1), _files(), batch_size=2)

    assert failed == {"b.py", "c.py"}
    assert set(vectors) == {"a.py"}


def test_a_file_split_across_batches_fails_if_any_part_fails():
    # Batches: [a1] [a22] [b333] [c4444]
    vectors, failed = embed_chunks(FakeEmbedder(fail_on=1), _files(), batch_size=1)

    assert failed == {"a.py"}
    assert set(vectors) == {"b.py", "c.py"}


def test_dimension_mismatch_stops_ingestion():
    with pytest.raises(IngestionError, match="quota"):
        embed_chunks(FakeEmbedder(fail_on=0, error=EmbeddingDimensionError), _files())
