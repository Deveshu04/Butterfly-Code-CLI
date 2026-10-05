# 006: Cache-shaped context

Status: accepted

## Context

Input tokens dominate the cost of an agent session, and providers discount
cached prompt prefixes heavily. A prompt that is rebuilt each step loses that
discount.

## Options

1. Rebuild the full prompt every step (simple, cache-hostile).
2. Keep a frozen prefix and an append-only transcript, and update dynamic
   context as deltas.

## Decision

Option 2:

- The system prompt, memory files and skill index are frozen at session start.
- The transcript is append-only. Anthropic requests get explicit cache
  breakpoints on the prefix and the rolling tail.
- Dynamic sources (nested `AGENTS.md`, code-graph hints) are reconciled as
  deltas.
- System prompts come in families chosen by model id, because instruction
  style matters most for mid-tier models.
- When the window fills, old tool output is pruned first; only then are older
  turns summarized, with a structured template, while recent turns stay
  verbatim.

## Consequences

- Memory edits take effect in the next session, not mid-session.
- Cache hit rate is shown in `/status` so regressions are visible.
