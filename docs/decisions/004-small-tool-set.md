# 004: A small, fixed tool set with `op` dispatch

Status: accepted

## Context

Tool selection accuracy drops as the number of tools a model sees grows, and
every tool schema costs prompt tokens on every request. Mid-tier models are
hit hardest.

## Options

1. One tool per capability (dozens of tools).
2. A small fixed set, with related capabilities behind an `op` parameter.
3. Dynamic tool sets that change during a session (breaks prompt caching).

## Decision

Option 2. The model-visible set is twelve tools: `bash`, `read`, `edit`,
`glob`, `grep`, `todo`, `explore`, `memory`, `skill`, `task`, `mcp`, `web`.
Twelve is the ceiling. New capabilities extend an existing tool's `op`. MCP
servers are exposed through the single `mcp` tool with lazy schema loading.
The tool list never changes mid-session; unavailable tools are refused at call
time instead of being removed.

## Consequences

- Prompts stay small and cache-friendly regardless of how many MCP servers
  are configured.
- Some tools have richer schemas, so their descriptions must stay precise.
