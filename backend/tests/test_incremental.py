"""Change detection for incremental indexing (the full flow is in tests/integration)."""

import subprocess

from app.workers.tasks import blob_shas, plan_changes


def test_plan_changes_classifies_every_path():
    stored = {"a.py": "1", "b.py": "2", "gone.py": "3"}
    current = {"a.py": "1", "b.py": "9", "new.py": "4"}
    added, modified, deleted, unchanged = plan_changes(current, stored, full=False)
    assert (added, modified, deleted, unchanged) == ({"new.py"}, {"b.py"}, {"gone.py"}, {"a.py"})


def test_full_rebuild_treats_every_current_file_as_new():
    added, modified, deleted, unchanged = plan_changes({"a.py": "1"}, {"a.py": "1", "gone.py": "2"}, full=True)
    assert (added, modified, deleted, unchanged) == ({"a.py"}, set(), {"gone.py"}, set())


def test_files_without_a_recorded_hash_count_as_modified():
    # Indexes made before File nodes: the graph knows the path, but not its hash.
    _, modified, _, unchanged = plan_changes({"a.py": "1"}, {"a.py": ""}, full=False)
    assert modified == {"a.py"} and unchanged == set()


def test_blob_shas_match_git_and_change_with_content(tmp_path):
    git = ["git", "-C", str(tmp_path), "-c", "user.name=t", "-c", "user.email=t@example.com"]
    subprocess.run([*git, "init", "-q"], check=True)
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "a.py").write_text("x = 1\n")
    (tmp_path / "b.ts").write_text("export const b = 1;\n")
    subprocess.run([*git, "add", "."], check=True)
    subprocess.run([*git, "commit", "-q", "-m", "one"], check=True)

    first = blob_shas(tmp_path)
    assert set(first) == {"pkg/a.py", "b.ts"}
    expected = subprocess.run([*git, "hash-object", "pkg/a.py"], capture_output=True, text=True).stdout.strip()
    assert first["pkg/a.py"] == expected

    (tmp_path / "pkg" / "a.py").write_text("x = 2\n")
    subprocess.run([*git, "commit", "-q", "-am", "two"], check=True)
    second = blob_shas(tmp_path)
    assert second["pkg/a.py"] != first["pkg/a.py"] and second["b.ts"] == first["b.ts"]
