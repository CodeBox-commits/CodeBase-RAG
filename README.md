# GitHub RAG project

An enterprise-grade, developer intelligence platform that utilizes Abstract Syntax Tree (AST) parsing, Graph Knowledge Networks, and high-performance vector databases to execute precise structural search and contextual analysis across complex software repositories.

Standard Retrieval-Augmented Generation (RAG) models fail on code bases because naive text-splitting chops logical functions in half and destroys contextual inheritance. This engine eliminates hallucinations by structuring code assets into a unified Graph-Vector index.

---

## 🏗️ System Architecture & Data Flow

The platform separates data execution into two distinct decoupled pipelines:

### 1. Code Ingestion & Structural Indexing (Write Path)
* **Directory Traversal:** Programmatically clones target repositories and filters out hidden assets or binaries via customized configuration tracking.
* **AST Structural Splitting:** Syntactically tokenizes code files at exact function, class, and method boundaries using static analysis compilation logic.
* **Graph Network Ingestion (Neo4j):** Maps foundational dependencies explicitly into a relational graph structure using `IMPORTS`, `CALLS`, and `INHERITS` edge models.
* **Vector Property Syncing (Qdrant):** Computes dense multi-dimensional vector embeddings for functional signatures and docstrings to enable high-performance semantic exploration.

### 2. Contextual Graph Retrieval (Read Path)
* **Semantic Anchor Lookup:** Queries the vector database to discover the high-probability starting node matching the user's intent.
* **Multi-Hop Graph Traversal:** Executes dynamic Cypher queries to recursively walk up and down call paths, pulling complete functional chains up to three layers deep.
* **Agentic State Synthesis (LangGraph):** Evaluates context payload parameters via an automated double-gatekeeper loop, ensuring extracted data is relevant and output metrics are strictly grounded.

---

## 🛠️ Tech Stack & Infrastructure

* **Core Web Layer:** FastAPI (Python) - fully asynchronous, high-concurrency event handling.
* **Static Analysis Engine:** Python AST Native Interface / Tree-sitter Language Bindings.
* **Graph Knowledge Database:** Neo4j (Cypher Query Language Optimization).
* **Vector Analytics Client:** Qdrant Client Integration (Payload Filtering Optimization).
* **AI Orchestration Framework:** LangGraph State Machine Architecture.
* **Distributed Task Handling:** Celery Core Engine backed by a Redis Message Broker.

---

## 🌟 Core Target Features

- [ ] **Asynchronous Repository Cloning:** Clones and parses target code assets out-of-band without locking up the user thread.
- [ ] **AST Functional Chunking:** Isolates individual methods perfectly with absolute line-number boundary mappings.
- [ ] **Interactive Call-Graph Resolution:** Discovers every caller location for specific subroutines across multi-file architectures instantly.
- [ ] **Self-Correcting Graph Analysis:** Automatically rewrites search paths if preliminary lookups hit structural dead ends.
- [ ] **Automated Code Documentation:** Synthesizes comprehensive technical architecture summaries rooted entirely in your ground-truth call tree.

---

## 🚀 Local Development Environment Setup

1. **Clone the Repository Core:**
   ```bash
   git clone [https://github.com/YOUR_USERNAME/code-graphrag-engine.git](https://github.com/YOUR_USERNAME/code-graphrag-engine.git)
   cd code-graphrag-engine
