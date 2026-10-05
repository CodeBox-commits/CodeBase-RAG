import logging
import os
from typing import Any

from neo4j import Driver, GraphDatabase, exceptions

from app.core.call_resolver import Edge, Relationships
from app.core.schemas import ExtractedChunk

logger = logging.getLogger(__name__)

# Graph model:
#   (:Repository {url})
#   (:Symbol:Class | :Symbol:Function[:Method] {repo_url, filepath, qualified_name, name, ...})
#   (Repository)-[:CONTAINS_CLASS|CONTAINS_FUNCTION]->(Symbol)
#   (Class)-[:HAS_METHOD]->(Method)
#   (Symbol)-[:CALLS]->(Symbol)     resolved in-repo calls only
#   (Class)-[:INHERITS]->(Class)

_SCHEMA_STATEMENTS = [
    "CREATE INDEX symbol_identity IF NOT EXISTS FOR (n:Symbol) ON (n.repo_url, n.filepath, n.qualified_name)",
    "CREATE INDEX symbol_name IF NOT EXISTS FOR (n:Symbol) ON (n.repo_url, n.name)",
    "CREATE INDEX repository_url IF NOT EXISTS FOR (r:Repository) ON (r.url)",
]

_EDGE_TYPES = ("CALLS", "INHERITS", "HAS_METHOD")
_EDGE_BATCH_SIZE = 1000


def _run_write(tx: Any, query: str, **params: Any) -> None:
    """Transaction function for session.execute_write (retried by the driver on transient errors)."""
    tx.run(query, **params).consume()


_CONTEXT_QUERY = """
CALL {
    UNWIND $anchors AS a
    MATCH (n:Symbol {repo_url: $repo_url, filepath: a.filepath, qualified_name: a.symbol})
    RETURN n
    UNION
    MATCH (n:Symbol)
    WHERE n.repo_url = $repo_url AND (n.name IN $names OR n.qualified_name IN $names)
    RETURN n
}
WITH DISTINCT n
LIMIT $anchor_limit
CALL {
    WITH n
    OPTIONAL MATCH p = (n)-[:CALLS*1..__MAX_DEPTH__]->(m:Symbol)
    WITH m, min(length(p)) AS hops
    WHERE m IS NOT NULL
    WITH m, hops ORDER BY hops, m.qualified_name
    RETURN collect({name: m.qualified_name, filepath: m.filepath, line: m.start_line, hops: hops})[..$fanout] AS calls
}
CALL {
    WITH n
    OPTIONAL MATCH p = (m:Symbol)-[:CALLS*1..__MAX_DEPTH__]->(n)
    WITH m, min(length(p)) AS hops
    WHERE m IS NOT NULL
    WITH m, hops ORDER BY hops, m.qualified_name
    RETURN collect({name: m.qualified_name, filepath: m.filepath, line: m.start_line, hops: hops})[..$fanout] AS called_by
}
RETURN
    labels(n)            AS node_labels,
    n.qualified_name     AS name,
    n.filepath           AS filepath,
    n.start_line         AS start_line,
    n.end_line           AS end_line,
    n.docstring          AS docstring,
    calls,
    called_by,
    head([(o:Class)-[:HAS_METHOD]->(n) | o.qualified_name])             AS owner,
    [(n)-[:INHERITS]->(b:Class) | b.qualified_name]                    AS bases,
    [(s:Class)-[:INHERITS]->(n) | s.qualified_name][..$fanout]         AS subclasses,
    [(n)-[:HAS_METHOD]->(meth) | meth.qualified_name][..$fanout]       AS methods,
    // Same-named methods up and down the class hierarchy: a call to the base method
    // may run a subclass override at runtime, which the CALLS edges alone never show.
    [(n)<-[:HAS_METHOD]-(:Class)-[:INHERITS*1..5]->(:Class)-[:HAS_METHOD]->(m)
        WHERE m.name = n.name | {name: m.qualified_name, filepath: m.filepath, line: m.start_line}] AS overrides,
    [(n)<-[:HAS_METHOD]-(:Class)<-[:INHERITS*1..5]-(:Class)-[:HAS_METHOD]->(m)
        WHERE m.name = n.name | {name: m.qualified_name, filepath: m.filepath, line: m.start_line}][..$fanout]
        AS overridden_by
"""

# Direction is spliced in as a fixed arrow, depth as an int; neither comes from user text.
_NEIGHBOURS_QUERY = """
MATCH (n:Symbol {repo_url: $repo_url})
WHERE (n.qualified_name = $name OR ($bare AND n.name = $name))
  AND ($filepath IS NULL OR n.filepath = $filepath)
WITH n ORDER BY n.filepath, n.qualified_name
LIMIT $match_limit
OPTIONAL MATCH p = (n)__PATTERN__(m:Symbol)
WITH n, m, min(length(p)) AS hops
ORDER BY hops, m.filepath, m.qualified_name
WITH n, collect(CASE WHEN m IS NULL THEN NULL ELSE
    {name: m.qualified_name, filepath: m.filepath, line: m.start_line, type: m.type, hops: hops} END) AS found
RETURN n.qualified_name AS name, n.filepath AS filepath, n.start_line AS start_line,
       n.end_line AS end_line, n.type AS type, found[..$limit] AS symbols, size(found) AS total
"""

_FIND_QUERY = """
MATCH (n:Symbol {repo_url: $repo_url})
WHERE (n.qualified_name = $name OR ($bare AND n.name = $name))
  AND ($filepath IS NULL OR n.filepath = $filepath)
RETURN n.qualified_name AS name, n.filepath AS filepath, n.start_line AS start_line,
       n.end_line AS end_line, n.type AS type
ORDER BY filepath, name
LIMIT $limit
"""

# One level of "what depends on these symbols": callers, subclasses and (optionally)
# overriding methods. Impact analysis walks this level by level, so the cost stays linear
# in the number of affected symbols instead of in the number of paths.
_DEPENDENTS_QUERY = """
UNWIND $frontier AS f
MATCH (n:Symbol {repo_url: $repo_url, filepath: f.filepath, qualified_name: f.name})
CALL {
    WITH n
    MATCH (m:Symbol)-[r:CALLS|INHERITS]->(n)
    RETURN m, type(r) AS relation
    UNION
    WITH n
    MATCH (n)<-[:HAS_METHOD]-(:Class)<-[:INHERITS*1..5]-(:Class)-[:HAS_METHOD]->(m)
    WHERE $with_overrides AND m.name = n.name
    RETURN m, "OVERRIDES" AS relation
}
RETURN f.filepath AS via_filepath, f.name AS via_name,
       m.qualified_name AS name, m.filepath AS filepath, m.start_line AS start_line,
       m.end_line AS end_line, m.type AS type, relation
// An override that also calls super() is reported as the more specific "OVERRIDES".
ORDER BY via_filepath, via_name, CASE relation WHEN "OVERRIDES" THEN 0 ELSE 1 END, relation, filepath, name
"""

_REPOSITORIES_QUERY = """
MATCH (r:Repository)
RETURN r.url AS url, r.last_indexed AS last_indexed,
       COUNT { (r)-[:CONTAINS_CLASS|CONTAINS_FUNCTION]->() } AS symbols
ORDER BY r.last_indexed DESC
"""

_NEIGHBOUR_PATTERNS = {"callees": "-[:CALLS*1..__DEPTH__]->", "callers": "<-[:CALLS*1..__DEPTH__]-"}


class Neo4jService:
    def __init__(self):
        self.uri = os.getenv("NEO4J_URI", "bolt://neo4j:7687")
        self.user = os.getenv("NEO4J_USER", "neo4j")
        self.password = os.getenv("NEO4J_PASSWORD", "password123")
        self.driver: Driver | None = None

    def _require_driver(self) -> Driver:
        """The driver, connecting first if needed (callers never see None)."""
        if self.driver is None:
            self.connect()
        assert self.driver is not None
        return self.driver

    def connect(self):
        if not self.driver:
            try:
                self.driver = GraphDatabase.driver(
                    self.uri, auth=(self.user, self.password), max_connection_pool_size=50
                )
                self.driver.verify_connectivity()
                self._ensure_schema()
                logger.info("✅ Neo4j Connection Pool Initialized.")
            except exceptions.ServiceUnavailable as e:
                self.driver = None
                logger.error("❌ Failed to connect to Neo4j. Is the container running?")
                raise e

    def _ensure_schema(self):
        with self._require_driver().session() as session:
            for statement in _SCHEMA_STATEMENTS:
                session.run(statement).consume()

    def ping(self) -> None:
        """Raises if Neo4j isn't reachable (used by the readiness probe)."""
        self._require_driver().verify_connectivity()

    def close(self):
        if self.driver:
            self.driver.close()

    def merge_repository(self, repo_url: str):
        query = """
        MERGE (r:Repository {url: $url})
        ON CREATE SET r.created_at = timestamp(), r.last_indexed = timestamp()
        ON MATCH SET r.last_indexed = timestamp()
        RETURN elementId(r)
        """
        with self._require_driver().session() as session:
            session.execute_write(lambda tx: tx.run(query, url=repo_url).consume())

    def delete_repository_data(self, repo_url: str):
        # Function/UnresolvedCall cover nodes written by the pre-Symbol schema.
        # CALL {} IN TRANSACTIONS needs an auto-commit transaction, hence session.run.
        symbols_query = """
        MATCH (n)
        WHERE (n:Symbol OR n:Function OR n:UnresolvedCall) AND n.repo_url = $repo_url
        CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS
        """
        repo_query = "MATCH (r:Repository {url: $repo_url}) DETACH DELETE r"
        with self._require_driver().session() as session:
            session.run(symbols_query, repo_url=repo_url).consume()
            session.run(repo_query, repo_url=repo_url).consume()

    def merge_symbols(self, repo_url: str, chunks: list[ExtractedChunk]):
        if not chunks:
            return
        query = """
        MATCH (r:Repository {url: $repo_url})
        UNWIND $rows AS row
        MERGE (n:Symbol {repo_url: $repo_url, filepath: row.filepath, qualified_name: row.qualified_name})
        SET n.name = row.name,
            n.type = row.type,
            n.docstring = row.docstring,
            n.start_line = row.start_line,
            n.end_line = row.end_line
        FOREACH (_ IN CASE WHEN row.type = 'class' THEN [1] ELSE [] END |
            SET n:Class
            MERGE (r)-[:CONTAINS_CLASS]->(n)
        )
        FOREACH (_ IN CASE WHEN row.type <> 'class' THEN [1] ELSE [] END |
            SET n:Function
            MERGE (r)-[:CONTAINS_FUNCTION]->(n)
        )
        FOREACH (_ IN CASE WHEN row.type = 'method' THEN [1] ELSE [] END |
            SET n:Method
        )
        """
        rows = [
            {
                "filepath": c.file_path,
                "qualified_name": c.qualified_name,
                "name": c.name,
                "type": c.type,
                "docstring": c.docstring,
                "start_line": c.start_line,
                "end_line": c.end_line,
            }
            for c in chunks
        ]
        with self._require_driver().session() as session:
            session.execute_write(lambda tx: tx.run(query, repo_url=repo_url, rows=rows).consume())

    def merge_relationships(self, repo_url: str, relationships: Relationships):
        self._merge_edges(repo_url, "CALLS", relationships.calls)
        self._merge_edges(repo_url, "INHERITS", relationships.inherits)
        self._merge_edges(repo_url, "HAS_METHOD", relationships.has_method)

    def _merge_edges(self, repo_url: str, rel_type: str, edges: list[Edge]):
        if rel_type not in _EDGE_TYPES:
            raise ValueError(f"Unknown relationship type: {rel_type}")
        if not edges:
            return
        query = f"""
        UNWIND $edges AS e
        MATCH (a:Symbol {{repo_url: $repo_url, filepath: e.src_file, qualified_name: e.src_name}})
        MATCH (b:Symbol {{repo_url: $repo_url, filepath: e.dst_file, qualified_name: e.dst_name}})
        MERGE (a)-[:{rel_type}]->(b)
        """
        rows = [{"src_file": src[0], "src_name": src[1], "dst_file": dst[0], "dst_name": dst[1]} for src, dst in edges]
        with self._require_driver().session() as session:
            for i in range(0, len(rows), _EDGE_BATCH_SIZE):
                batch = rows[i : i + _EDGE_BATCH_SIZE]
                session.execute_write(_run_write, query, repo_url=repo_url, edges=batch)

    def get_symbol_context(
        self,
        repo_url: str,
        anchors: list[dict[str, str]],
        names: list[str],
        max_depth: int = 3,
        anchor_limit: int = 15,
        fanout: int = 10,
    ) -> list[dict[str, Any]]:
        """Structural neighbourhood of the given symbols.

        anchors: exact symbols ({"filepath", "symbol"}) e.g. from vector hits.
        names:   bare or qualified names e.g. extracted from the user's question.
        """
        if not anchors and not names:
            return []
        # Variable-length bounds can't be query parameters; int() keeps this injection-safe.
        query = _CONTEXT_QUERY.replace("__MAX_DEPTH__", str(int(max_depth)))
        with self._require_driver().session() as session:
            result = session.run(
                query,
                repo_url=repo_url,
                anchors=anchors,
                names=names,
                anchor_limit=anchor_limit,
                fanout=fanout,
            )
            return [record.data() for record in result]

    def get_call_neighbours(
        self,
        repo_url: str,
        name: str,
        direction: str,
        depth: int = 1,
        filepath: str | None = None,
        limit: int = 200,
        match_limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Callers or callees of every symbol called `name`, up to `depth` hops away.

        A dotted name (`Cart.checkout`) must match the qualified name; a bare one (`checkout`)
        also matches every symbol with that short name, so each match gets its own row.
        """
        if direction not in _NEIGHBOUR_PATTERNS:
            raise ValueError(f"direction must be one of {sorted(_NEIGHBOUR_PATTERNS)}")
        pattern = _NEIGHBOUR_PATTERNS[direction].replace("__DEPTH__", str(int(depth)))
        query = _NEIGHBOURS_QUERY.replace("__PATTERN__", pattern)
        with self._require_driver().session() as session:
            result = session.run(
                query,
                repo_url=repo_url,
                name=name,
                bare="." not in name,
                filepath=filepath,
                limit=limit,
                match_limit=match_limit,
            )
            return [record.data() for record in result]

    def find_symbols(
        self, repo_url: str, name: str, filepath: str | None = None, limit: int = 10
    ) -> list[dict[str, Any]]:
        """Definitions called `name` (qualified if dotted, else also by short name)."""
        with self._require_driver().session() as session:
            result = session.run(
                _FIND_QUERY, repo_url=repo_url, name=name, bare="." not in name, filepath=filepath, limit=limit
            )
            return [record.data() for record in result]

    def get_direct_dependents(
        self, repo_url: str, frontier: list[dict[str, str]], with_overrides: bool = False
    ) -> list[dict[str, Any]]:
        """Symbols one edge away that depend on any symbol in `frontier` ({"filepath", "name"})."""
        if not frontier:
            return []
        with self._require_driver().session() as session:
            result = session.run(_DEPENDENTS_QUERY, repo_url=repo_url, frontier=frontier, with_overrides=with_overrides)
            return [record.data() for record in result]

    def list_repositories(self) -> list[dict[str, Any]]:
        with self._require_driver().session() as session:
            return [record.data() for record in session.run(_REPOSITORIES_QUERY)]

    def get_repository_graph(self, repo_url: str, limit: int = 400) -> dict[str, Any]:
        """The most connected symbols of a repository and the edges between them."""
        nodes_query = """
        MATCH (n:Symbol {repo_url: $repo_url})
        WITH n, COUNT { (n)--(:Symbol) } AS degree
        ORDER BY degree DESC, n.qualified_name
        LIMIT $limit
        RETURN n.filepath + "::" + n.qualified_name AS id,
               n.qualified_name AS name, n.type AS kind, n.filepath AS filepath,
               n.start_line AS start_line, n.end_line AS end_line, degree
        """
        edges_query = """
        MATCH (a:Symbol {repo_url: $repo_url})-[r:CALLS|INHERITS|HAS_METHOD]->(b:Symbol {repo_url: $repo_url})
        WITH a.filepath + "::" + a.qualified_name AS source,
             b.filepath + "::" + b.qualified_name AS target, type(r) AS type
        WHERE source IN $ids AND target IN $ids
        RETURN source, target, type
        """
        with self._require_driver().session() as session:
            nodes = [r.data() for r in session.run(nodes_query, repo_url=repo_url, limit=limit)]
            ids = [n["id"] for n in nodes]
            edges = [r.data() for r in session.run(edges_query, repo_url=repo_url, ids=ids)]
            record = session.run(
                "MATCH (n:Symbol {repo_url: $repo_url}) RETURN count(n) AS c", repo_url=repo_url
            ).single()
            total = record["c"] if record else 0
        return {"nodes": nodes, "edges": edges, "total_symbols": total}


graph_db = Neo4jService()
