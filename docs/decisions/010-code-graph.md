# 010: A local tree-sitter + SQLite code graph with PageRank

Status: accepted

## Context

Models waste many tokens finding their way around a repository with grep and
whole-file reads. Embedding indexes need a model and a vector store, and
summaries written by models go stale.

## Options

1. No index: grep and read only.
2. Embeddings and a vector database.
3. A symbol graph from tree-sitter, ranked with personalized PageRank.

## Decision

Option 3. Tree-sitter tag queries extract definitions and references into
SQLite (files, symbols, edges, full-text search). Personalized PageRank
weights files in the conversation and symbols the user named. The first turn
gets a budgeted overview and ranked map; later turns get short targeted hints;
the `explore` tool answers map, outline, symbol and dependency questions.
Sync is incremental by content hash.

## Consequences

- Fully local, deterministic, no extra model calls.
- Language support depends on available grammars and tag queries (TypeScript,
  JavaScript, Python, Go, Rust and Java today).
