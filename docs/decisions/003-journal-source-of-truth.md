# 003: Append-only JSONL journals are the source of truth; SQLite is derived

Status: accepted

## Context

Long-running work must survive crashes and resume without re-reading or
re-summarising the conversation with a model. State formats that change
without versioning are expensive to migrate.

## Options

1. A database as the primary store.
2. Plain conversation logs.
3. An append-only journal of typed events, with derived indexes.

## Decision

Option 3. Every session and loop writes an append-only JSONL journal of typed
events (messages, tool calls and results, snapshots, compactions, rewinds,
gate results). The first line is a version header. SQLite holds only derived,
rebuildable data: the session list, full-text search, the work queue and the
code graph. Deleting a `.db` file never loses information.

## Consequences

- Resume is a fold over events plus a git status check. It costs no tokens.
- The format must stay backward compatible: events are only added, new fields
  are optional, and old journals must keep replaying.
- Undo and rewind are journal events, not deletions.
