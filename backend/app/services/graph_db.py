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

    def merge_class(self, repo_url: str, file_path: str, class_data: Dict[str, Any]):
        query = """

        MATCH (r:Repository {url: $repo_url})
        
        MERGE (c:Class {filepath: $file_path, name: $class_name})
        SET c.docstring = $docstring, c.start_line = $start_line

        MERGE (r)-[:CONTAINS_CLASS]->(c)
        """
        with self.driver.session() as session:
            session.execute_write(lambda tx: tx.run(
                query,
                repo_url=repo_url,
                file_path=file_path,
                class_name=class_data.get("name"),
                docstring=class_data.get("docstring"),
                start_line=class_data.get("lineno")
            ))

graph_db = Neo4jService()