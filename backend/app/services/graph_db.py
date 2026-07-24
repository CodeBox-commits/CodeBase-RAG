import os
import logging
from typing import Any, Dict, List
from neo4j import GraphDatabase, exceptions

logger = logging.getLogger(__name__)

class Neo4jService:
    def __init__(self):
        self.uri = os.getenv("NEO4J_URI", "bolt://neo4j:7687")
        self.user = os.getenv("NEO4J_USER", "neo4j")
        self.password = os.getenv("NEO4J_PASSWORD", "password")
        self.driver = None

    def connect(self):
        if not self.driver:
            try:
                self.driver = GraphDatabase.driver(
                    self.uri, 
                    auth=(self.user, self.password),
                    max_connection_pool_size=50 
                )
                self.driver.verify_connectivity()
                logger.info("✅ Neo4j Connection Pool Initialized.")
            except exceptions.ServiceUnavailable as e:
                logger.error("❌ Failed to connect to Neo4j. Is the container running?")
                raise e

    def close(self):
        if self.driver:
            self.driver.close()

    def merge_repository(self, repo_url: str):
        query = """
        MERGE (r:Repository {url: $url})
        ON CREATE SET r.created_at = timestamp(), r.last_indexed = timestamp()
        ON MATCH SET r.last_indexed = timestamp()
        RETURN id(r)
        """
        with self.driver.session() as session:
            session.execute_write(lambda tx: tx.run(query, url=repo_url))

    def merge_function(self, repo_url: str, file_path: str, chunk_data: Dict[str, Any]):
        query = """
        MATCH (r:Repository {url: $repo_url})
        
        MERGE (f:Function {filepath: $file_path, name: $name})
        SET f.docstring = $docstring,
            f.start_line = $start_line,
            f.end_line = $end_line,
            f.type = $type
            
        MERGE (r)-[:CONTAINS_FUNCTION]->(f)
        
        FOREACH (ignoreMe IN CASE WHEN $type = 'method' THEN [1] ELSE [] END |
            SET f:Method
        )
        
        WITH f
        UNWIND $calls AS callee_name
        MERGE (callee:Function {name: callee_name})
        MERGE (f)-[:CALLS]->(callee)
        """
        with self.driver.session() as session:
            session.execute_write(lambda tx: tx.run(
                query,
                repo_url=repo_url,
                file_path=file_path,
                name=chunk_data.get("name"),
                type=chunk_data.get("type"),
                start_line=chunk_data.get("start_line"),
                end_line=chunk_data.get("end_line"),
                docstring=chunk_data.get("docstring"),
                calls=chunk_data.get("calls", [])
            ))

graph_db = Neo4jService()