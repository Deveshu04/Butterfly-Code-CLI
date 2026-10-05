# 009: Capped memory files, on-demand recall and verified skills

Status: accepted

## Context

Agents that remember across sessions save time, but memory that grows without
limit costs tokens on every request and drifts into noise or contradictions.

## Options

1. No persistent memory.
2. A vector database with automatic retrieval.
3. Small capped files in the prompt, plus on-demand search and skills.

## Decision

Option 3:

- `PROJECT.md` (project) and `USER.md` (user) have hard caps and are frozen
  into the prompt prefix at session start.
- Edits are small substring deltas. Exceeding the cap is an error that asks
  for consolidation; nothing is truncated silently.
- Past sessions are searchable with SQLite FTS5 on demand; that costs nothing
  until used.
- Skills use progressive disclosure: a one-line index in the prompt, the body
  loaded on demand. A drafted skill is promoted only after two verified runs.
- A post-turn reviewer on a cheaper model proposes memory and skill updates;
  agent-written entries are scanned for prompt injection and can be staged
  for approval.

## Consequences

- Standing token cost of memory is small and bounded.
- Memory changes apply from the next session.
