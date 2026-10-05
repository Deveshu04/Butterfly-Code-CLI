# 012: Subagents are a tool, not a mode

Status: accepted

## Context

Delegating exploration or independent subtasks keeps the main context small,
but separate "orchestrator modes" add a second way of working that users have
to learn and switch between.

## Options

1. A dedicated orchestrator mode.
2. A `task` tool the main agent can call when it decides to delegate.

## Decision

Option 2. `task` starts a subagent with its own journal and fresh context and
returns only a short summary. `tasks=[...]` runs up to six in parallel,
optionally in separate git worktrees, by default on a cheaper model. The
parent merges or discards each worktree. Subagent spend counts toward the
parent's budgets, and the UI can open each subagent's conversation live.

## Consequences

- One mode of operation; delegation is a decision the model makes per task.
- Summaries must be good enough to act on, since the parent never sees the
  subagent's full transcript.
