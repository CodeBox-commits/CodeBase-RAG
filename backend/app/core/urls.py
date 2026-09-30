def normalize_repo_url(url: str) -> str:
    """Canonical form used as the repository key in every store.

    Ingestion and querying must both go through this, otherwise a repo indexed as
    `https://github.com/a/b.git` is invisible to a question about `https://github.com/a/b/`.
    """
    url = str(url).strip().rstrip("/")
    if url.endswith(".git"):
        url = url[:-4]
    return url.rstrip("/")
