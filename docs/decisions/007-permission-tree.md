# 007: A permission tree instead of an OS sandbox

Status: accepted

## Context

The agent runs shell commands and edits files. Users need control without
being asked about every action. OS-level sandboxes differ per platform and
often break real development workflows.

## Options

1. An OS sandbox per platform.
2. Approve every action.
3. Rules per tool and pattern, with allow / ask / deny.

## Decision

Option 3. Rules are a tree of globs, for example
`{"*": "ask", "bash": {"git *": "allow"}, "edit": {".env*": "deny"}}`. The
most specific match wins and `deny` always wins. Headless runs never prompt:
`ask` becomes deny, and the exit code reports the outcome (`0`, `124` budget,
`1` error). Plan mode denies all mutating tools.

## Consequences

- No isolation beyond the rules; users who need more should run Butterfly in a
  container or VM.
- Quick-add from an approval prompt creates narrow rules, never wildcards.
